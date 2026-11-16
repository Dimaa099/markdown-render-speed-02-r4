// parse.js — a fast Markdown-to-HTML renderer whose output matches
// marked 18.1.3 (default options, GFM enabled) byte for byte.
//
// Design overview
// ---------------
// Rendering happens in two passes over the source:
//
//   1. Block pass. The document is scanned once from top to bottom and
//      split into block-level tokens: headings, paragraphs, lists,
//      tables, fenced/indented code, blockquotes, HTML blocks and link
//      reference definitions. Inline source is stored verbatim on each
//      token during this pass. Deferring inline work is what lets a
//      reference-style link resolve even when its definition appears
//      later in the document than the use.
//
//   2. Render pass. Block tokens are walked in order and each token's
//      inline source is expanded by a dedicated inline scanner
//      (emphasis, code spans, links, autolinks, raw HTML, escapes).
//
// Performance notes: the hot loops are hand-written character scanners
// rather than large regular expressions, plain text is consumed in
// long runs guided by lookup tables, block matchers peek at the first
// meaningful character before running, and line splitting is lazy so
// failed matchers never pay for scanning the whole input.
// This module has no imports and keeps no state between calls.

// ---------------------------------------------------------------------
// HTML escaping and character-reference handling
// ---------------------------------------------------------------------

const ESCAPE_MAP = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const ESCAPE_ALL_RE = /[&<>"']/g;
const ESCAPE_ALL_TEST = /[&<>"']/;
// Variant that leaves an existing "&...;" reference untouched.
const ESCAPE_KEEP_RE = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
const ESCAPE_KEEP_TEST = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/;

function escapeHtml(text, escapeEverything) {
  if (escapeEverything) {
    return ESCAPE_ALL_TEST.test(text) ? text.replace(ESCAPE_ALL_RE, (ch) => ESCAPE_MAP[ch]) : text;
  }
  return ESCAPE_KEEP_TEST.test(text)
    ? text.replace(ESCAPE_KEEP_RE, (ch) => ESCAPE_MAP[ch])
    : text;
}

const CHARREF_PRESENT_RE = /&#(?:\d{1,7}|[Xx][A-Fa-f0-9]{1,6});/;
const CHARREF_OR_AMP_RE = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;

// Decode numeric character references the way marked does: NUL,
// out-of-range values and surrogates become U+FFFD, and "&" itself is
// re-escaped so the result stays valid HTML text.
function decodeCharRefs(text) {
  if (text.indexOf("&") === -1) return text;
  if (!CHARREF_PRESENT_RE.test(text)) return text;
  return text.replace(CHARREF_OR_AMP_RE, (whole, decimal, hex) => {
    if (decimal === undefined && hex === undefined) return "&amp;";
    const codePoint = decimal === undefined ? parseInt(hex, 16) : parseInt(decimal, 10);
    if (codePoint === 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
      return "\uFFFD";
    }
    if (codePoint === 38) return "&amp;";
    return String.fromCodePoint(codePoint);
  });
}

// Percent-encode a link destination; a URI that cannot be encoded at
// all makes the link render as bare text, mirroring marked.
function cleanUrl(href) {
  try {
    return encodeURI(href).replace(/%25/g, "%");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------
// Small string utilities
// ---------------------------------------------------------------------

// Length of the run of `ch` at the very end of `text`.
function trailingRun(text, ch) {
  let count = 0;
  for (let i = text.length - 1; i >= 0 && text[i] === ch; i--) count++;
  return count;
}

// Scan for bracket balance while honouring backslash escapes.
// Returns the index of the first closer that drops depth below zero,
// -2 when the string ends with unclosed openers, otherwise -1.
function parenBalance(text, openCh, closeCh) {
  if (text.indexOf(openCh) === -1 && text.indexOf(closeCh) === -1) return -1;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\") i++;
    else if (ch === openCh) depth++;
    else if (ch === closeCh) {
      depth--;
      if (depth < 0) return i;
    }
  }
  return depth > 0 ? -2 : -1;
}

// Reference labels compare case-insensitively with whitespace folded.
function labelKey(label) {
  return label.trim().replace(/\s+/g, " ").toLowerCase().toUpperCase().toLowerCase();
}

const ESCAPED_PUNCT_GLOBAL_RE = /\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/g;

function removeEscapes(text) {
  return text.replace(ESCAPED_PUNCT_GLOBAL_RE, "$1");
}

// Expand tabs inside a leading-whitespace prefix, where `offset` is
// the column the prefix starts at (tab stops are every 4 columns).
function expandLeadingTabs(prefix, offset) {
  let out = "";
  let column = offset;
  for (let i = 0; i < prefix.length; i++) {
    if (prefix[i] === "\t") {
      const step = 4 - (column % 4);
      out += " ".repeat(step);
      column += step;
    } else {
      out += prefix[i];
      column++;
    }
  }
  return out;
}

// Drop trailing blank lines beyond the first one, matching the way
// marked trims raw block content.
function trimBlankTail(raw) {
  const lines = raw.split("\n");
  let last = lines.length - 1;
  while (last >= 0 && /^[ \t]*$/.test(lines[last])) last--;
  if (lines.length - last <= 2) return raw;
  return lines.slice(0, last + 1).join("\n");
}

// ---------------------------------------------------------------------
// Shared block-level vocabulary
// ---------------------------------------------------------------------

const BLOCK_TAG_NAMES =
  "address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul";

const BLOCK_TAG_START_RE = new RegExp("^(?:" + BLOCK_TAG_NAMES + ")(?=[ \\t]|\\n|/?>|$)");
const HTML_BLOCK_START_RE = new RegExp(
  "^ {0,3}(?:</?(?:" + BLOCK_TAG_NAMES + ")(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)",
  "i"
);
const BLANK_LINE_RE = /^[ \t]*$/;

// ---------------------------------------------------------------------
// Inline grammar patterns
//
// These expressions encode the exact shapes marked accepts for link
// labels, titles and destinations; they are assembled from fragments
// so the nesting rules stay readable.
// ---------------------------------------------------------------------

const INNER_BRACKET = "\\[(?:\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]";
const LABEL_INNER = "\\[(?:" + INNER_BRACKET + "|\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]";
const LABEL_PATTERN =
  "(?:" + LABEL_INNER + "|\\\\[\\s\\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\\])|[^\\[\\]\\\\`])*?";
const TITLE_PATTERN =
  "(?:\"(?:\\\\[\\s\\S]|[^\"\\\\])*\"|'(?:\\\\[\\s\\S]|[^'\\\\\\n]|\\n(?!\\n))*'|\\((?:\\\\[\\s\\S]|[^)\\\\])*\\))";
const HREF_PATTERN = "<(?:\\\\.|[^\\n<>\\\\])+>|[^ \\t\\n\\x00-\\x1f]+|(?=\\))";
const INLINE_LINK_RE = new RegExp(
  "^(!?)\\[(" + LABEL_PATTERN + ")\\]\\([ \\t\\n]*(" + HREF_PATTERN + ")(?:(?:[ \\t]+(?:\\n[ \\t]*)?|\\n[ \\t]*)(" + TITLE_PATTERN + "))?[ \\t\\n]*\\)"
);
const REF_LABEL_PATTERN =
  "(?:[^\\[\\]\\\\`]*(?:" + LABEL_INNER + "|\\\\[\\s\\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\\]))){0,999}?[^\\[\\]\\\\`]*?";
const REF_TEXT_PATTERN = "(?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\]){1,999}";
const REF_LINK_RE = new RegExp("^(!?)\\[(" + REF_LABEL_PATTERN + ")\\]\\[(" + REF_TEXT_PATTERN + ")\\]");
const SHORT_REF_RE = new RegExp("^(!?)\\[(" + REF_TEXT_PATTERN + ")\\](?:\\[\\])?");
const REF_SCAN_RE = new RegExp(
  "(?:!?)\\[(?:" + REF_LABEL_PATTERN + ")\\]\\[(?:" + REF_TEXT_PATTERN + ")\\]|(?:!?)\\[(?:" + REF_TEXT_PATTERN + ")\\](?:\\[\\])?",
  "g"
);
// Spans that must be skipped wholesale when probing for real links:
// complete inline links, code spans and simple tags.
const SKIP_LINK_SPAN_RE =
  /\[(?:[^\[\]`]|(`+)[^`]+\1(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)|(?<!`)()(`+)[^`]+\3(?!`)|<(?! )[^<>]*?>/g;
// Masking pass: hide code-span bodies, escapes and link spans behind
// placeholder characters of the same length so delimiter searches in
// the emphasis machinery never see their contents.
const DELIM_MASK_RE = /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\([\p{P}\p{S}])/gu;
const BACKSLASH_ESCAPE_RE = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/;
const CODE_SPAN_RE = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
const HARD_BREAK_RE = /^( {2,}|\\)\n(?!\s*$)[ \t]*/;
const ANGLE_AUTOLINK_RE =
  /^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s\x00-\x1f<>]*|[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_]))>/;
const HTML_TAG_RE =
  /^<!--(?:-?>|[\s\S]*?-->)|^<\/[a-zA-Z][a-zA-Z0-9-]*\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?)*?\s*\/?>|^<\?[\s\S]*?\?>|^<![a-zA-Z]+\s[\s\S]*?>|^<!\[CDATA\[[\s\S]*?\]\]>/;
const ANCHOR_OPEN_RE = /^<a /i;
const ANCHOR_CLOSE_RE = /^<\/a>/i;
const RAW_OPEN_RE = /^<(pre|code|kbd|script)(\s|>)/i;
const RAW_CLOSE_RE = /^<\/(pre|code|kbd|script)(\s|>)/i;

// Emphasis openers/closers follow the CommonMark flanking rules as
// specialised by marked (including its GFM tweak that excludes "~"
// from the punctuation class around asterisks and underscores).
const PUNCT_CLASS = "[\\p{P}\\p{S}]";
const PUNCT_CLASS_GFM = "(?!~)[\\p{P}\\p{S}]";
const EM_OPEN_RE = new RegExp(
  "^(?:\\*+(?:((?!\\*)" + PUNCT_CLASS_GFM + ")|([^\\s*]))?)|^_+(?:((?!_)" + PUNCT_CLASS_GFM + ")|([^\\s_]))?",
  "u"
);
const PUNCT_OR_SPACE_TEST = /^(?![*_])[\s\p{P}\p{S}]/u;
const ALNUM_TEST = /[\p{L}\p{N}]/u;
const NON_PUNCT_SPACE = "[^\\s\\p{P}\\p{S}]";
const PUNCT_OR_SPACE_CLASS = "[\\s\\p{P}\\p{S}]";
const NPS_ALT = "(?:[^\\s\\p{P}\\p{S}]|~)";
const PS_ALT = "(?!~)[\\s\\p{P}\\p{S}]";
const EM_CLOSE_AST_RE = new RegExp(
  "^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])" +
    "|(?!\\*)" + PUNCT_CLASS_GFM + "(\\*+)(?=[\\s]|$)" +
    "|" + NPS_ALT + "(\\*+)(?!\\*)(?=" + PS_ALT + "|$)" +
    "|(?!\\*)" + PS_ALT + "(\\*+)(?=" + NPS_ALT + ")" +
    "|[\\s](\\*+)(?!\\*)(?=" + PUNCT_CLASS_GFM + ")" +
    "|(?!\\*)" + PUNCT_CLASS_GFM + "(\\*+)(?!\\*)(?=" + PUNCT_CLASS_GFM + ")" +
    "|" + NPS_ALT + "(\\*+)(?=" + NPS_ALT + ")",
  "gu"
);
const EM_CLOSE_UND_RE = new RegExp(
  "^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])" +
    "|(?!_)" + PUNCT_CLASS + "(_+)(?=[\\s]|$)" +
    "|" + NON_PUNCT_SPACE + "(_+)(?!_)(?=" + PUNCT_OR_SPACE_CLASS + "|$)" +
    "|(?!_)" + PUNCT_OR_SPACE_CLASS + "(_+)(?=" + NON_PUNCT_SPACE + ")" +
    "|[\\s](_+)(?!_)(?=" + PUNCT_CLASS + ")" +
    "|(?!_)" + PUNCT_CLASS + "(_+)(?!_)(?=" + PUNCT_CLASS + ")",
  "gu"
);
const DEL_OPEN_RE = new RegExp("^~~?(?:((?!~)" + PUNCT_CLASS + ")|([^\\s~]))", "u");
const DEL_CLOSE_RE = new RegExp(
  "^[^~]+(?=[^~])|(?!~)" + PUNCT_CLASS + "(~~?)(?=[\\s]|$)|" +
    NON_PUNCT_SPACE + "(~~?)(?!~)(?=" + PUNCT_OR_SPACE_CLASS + "|$)|(?!~)" + PUNCT_OR_SPACE_CLASS + "(~~?)(?=" + NON_PUNCT_SPACE + ")" +
    "|[\\s](~~?)(?!~)(?=" + PUNCT_CLASS + ")|(?!~)" + PUNCT_CLASS + "(~~?)(?!~)(?=" + PUNCT_CLASS + ")" +
    "|" + NON_PUNCT_SPACE + "(~~?)(?=" + NON_PUNCT_SPACE + ")",
  "gu"
);

// GFM bare autolinks: explicit protocols, "www." hosts, mailto:/xmpp:
// forms and plain email addresses.
const EMAIL_LOCAL = "[a-zA-Z0-9._+-]+";
const EMAIL_DOMAIN = "[a-zA-Z0-9-_]+(?:\\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\\w-])";
const PROTOCOL_PATTERN = "(?:[hH][tT][tT][pP][sS]?|[fF][tT][pP])";
const BARE_URL_RE = new RegExp(
  "^(?:mailto:" + EMAIL_LOCAL + "@" + EMAIL_DOMAIN +
    "|xmpp:" + EMAIL_LOCAL + "@" + EMAIL_DOMAIN + "(?:\\/[a-zA-Z0-9@.]+)?|((" +
    PROTOCOL_PATTERN + "):\\/\\/|www\\.)(?:[a-zA-Z0-9\\-]+\\.?)+[^\\s<]*|(" +
    EMAIL_LOCAL + ")@(" + "[a-zA-Z0-9-_]+(?:\\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\\w-])))"
);
// Trailing punctuation is peeled off a bare URL one layer at a time.
const URL_TRIM_RE = /^(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;
const DELIM_RUN_SCAN_RE = /(?:\*+|_+|~+)/g;

// ---------------------------------------------------------------------
// Delimiter bookkeeping for the inline scanner
// ---------------------------------------------------------------------

// For each delimiter character, remember the offset of its last run
// that could act as a closer (a run not preceded by whitespace). The
// emphasis search never needs to look past that offset.
function computeLastClosers(masked) {
  const last = { "*": -1, _: -1, "~": -1 };
  DELIM_RUN_SCAN_RE.lastIndex = 0;
  let match;
  while ((match = DELIM_RUN_SCAN_RE.exec(masked)) !== null) {
    const at = match.index;
    const before = at === 0 ? "\n" : masked.charAt(at - 1);
    if (before !== " " && before !== "\t" && before !== "\n" && before !== "\r" && before !== "\f") {
      last[match[0].charAt(0)] = at;
    }
  }
  return last;
}

// Does this text contain a link that would actually render? Used to
// decide whether a reference span should be masked: marked only
// treats a bracketed span as opaque when it is not itself a link.
function containsRealLink(text, refs) {
  if (text.indexOf("[") === -1) return false;
  SKIP_LINK_SPAN_RE.lastIndex = 0;
  let match;
  while ((match = SKIP_LINK_SPAN_RE.exec(text)) !== null) {
    if (INLINE_LINK_RE.test(match[0]) && text.charAt(match.index - 1) !== "!") return true;
    if (match[0].length === 0) SKIP_LINK_SPAN_RE.lastIndex++;
  }
  REF_SCAN_RE.lastIndex = 0;
  while ((match = REF_SCAN_RE.exec(text)) !== null) {
    const span = match[0];
    const openAt = span.lastIndexOf("[");
    const known = Object.prototype.hasOwnProperty.call(refs, labelKey(span.slice(openAt + 1, -1)));
    if (span.charAt(0) !== "!" && known) {
      if (!(openAt > 1 && containsRealLink(span.slice(1, openAt - 1), refs))) return true;
    }
    if (match[0].length === 0) REF_SCAN_RE.lastIndex++;
  }
  return false;
}

// Build the length-preserving masked copy of the inline source:
// reference spans that resolve become filler, code-span interiors and
// escaped punctuation are neutralised, and finished inline links are
// collapsed to a bracketed filler run.
function buildDelimMask(text, refs) {
  let masked = text;
  if (masked.indexOf("[") !== -1) {
    const maskReference = (span) => {
      const openAt = span.lastIndexOf("[");
      if (!Object.prototype.hasOwnProperty.call(refs, labelKey(span.slice(openAt + 1, -1)))) return span;
      if (openAt > 1 && span.charAt(0) !== "!") {
        const inner = span.slice(1, openAt - 1);
        if (containsRealLink(inner, refs)) {
          return "[" + inner.replace(REF_SCAN_RE, maskReference) + "][" + "a".repeat(span.length - openAt - 2) + "]";
        }
      }
      return "[" + "a".repeat(span.length - 2) + "]";
    };
    masked = masked.replace(REF_SCAN_RE, maskReference);
  }
  masked = masked.replace(DELIM_MASK_RE, (whole, run, escaped) => {
    if (escaped !== undefined) return "+".repeat(whole.length);
    if (run !== undefined) {
      return run + whole.slice(run.length, whole.length - run.length).replace(/`/g, "+") + run;
    }
    return whole;
  });
  masked = masked.replace(SKIP_LINK_SPAN_RE, (whole) => "[" + "a".repeat(Math.max(0, whole.length - 2)) + "]");
  return masked;
}

// Match a code span at the start of `source`; on success return the
// raw span plus its normalised text (newlines become spaces, and one
// surrounding space pair is stripped when the content is not blank).
function matchCodeSpan(source) {
  const match = CODE_SPAN_RE.exec(source);
  if (!match) return null;
  let text = match[2].replace(/\n/g, " ");
  if (/[^ ]/.test(text) && text.charAt(0) === " " && text.charAt(text.length - 1) === " ") {
    text = text.slice(1, -1);
  }
  return { raw: match[0], text };
}

// A label can contain an HTML tag or autolink whose ">" lands beyond
// the closing bracket; in that case the bracket does not end a link.
function tagSwallowsBracket(source, label, labelOffset) {
  if (label.indexOf("<") === -1) return false;
  for (let at = 0; at < label.length; at++) {
    const ch = label[at];
    if (ch === "\\") { at++; continue; }
    if (ch === "`") {
      const span = CODE_SPAN_RE.exec(label.slice(at));
      if (span) { at += span[0].length - 1; continue; }
    }
    if (ch !== "<") continue;
    const tag = HTML_TAG_RE.exec(source.slice(labelOffset + at)) || ANGLE_AUTOLINK_RE.exec(source.slice(labelOffset + at));
    if (tag) {
      if (tag[0].length > label.length - at) return true;
      at += tag[0].length - 1;
    }
  }
  return false;
}

// Shared tail of link construction: tokenise the label, and reject a
// non-image link whose label itself produced a link (nested links are
// not allowed; marked drops the outer one in that case).
function makeLinkToken(label, href, title, raw, isImage, ctx) {
  const savedInLink = ctx.inLink;
  const savedEmitted = ctx.linkEmitted;
  const savedRawBlock = ctx.inRawBlock;
  ctx.inLink = true;
  ctx.linkEmitted = false;
  const tokens = tokenizeInline(label, ctx);
  const innerEmitted = ctx.linkEmitted;
  ctx.linkEmitted = savedEmitted;
  ctx.inLink = savedInLink;
  if (!isImage) {
    if (innerEmitted) {
      ctx.inRawBlock = savedRawBlock;
      return null;
    }
    ctx.linkEmitted = true;
  }
  return { k: isImage ? "image" : "link", raw, href, title: title ? title : null, text: label, tokens };
}

// Try an inline "[label](destination "title")" link at the start of
// `source`, including marked's destination-truncation behaviour when
// parentheses inside the destination are unbalanced.
function parseInlineLink(source, ctx) {
  const match = INLINE_LINK_RE.exec(source);
  if (!match) return null;
  const isImage = match[1] === "!";
  const label = match[2];
  if (tagSwallowsBracket(source, label, isImage ? 2 : 1)) return null;
  let raw = match[0];
  let href = match[3];
  let title = match[4];
  const destination = href.trim();
  if (destination.charAt(0) === "<") {
    if (destination.charAt(destination.length - 1) !== ">") return null;
    if (trailingRun(destination.slice(0, -1), "\\") % 2 === 1) return null;
  } else {
    const balance = parenBalance(href, "(", ")");
    if (balance === -2) return null;
    if (balance > -1) {
      const cut = (isImage ? 5 : 4) + label.length + balance;
      raw = raw.substring(0, cut).trim();
      href = href.substring(0, balance);
      title = undefined;
    }
  }
  if (trailingRun(raw.slice(0, -1), "\\") % 2 === 1) return null;
  let hrefText = href.trim();
  if (hrefText.charAt(0) === "<") hrefText = hrefText.slice(1, -1);
  const titleText = title ? title.slice(1, -1) : "";
  return makeLinkToken(label, removeEscapes(hrefText), removeEscapes(titleText), raw, isImage, ctx);
}

// Try a reference-style link: full "[label][key]", collapsed or
// shortcut forms. Unknown keys degrade to a single literal character,
// exactly as marked's lexer falls back to plain text.
function parseRefLink(source, ctx) {
  let match = REF_LINK_RE.exec(source);
  let label, keySource, isImage;
  if (match) {
    isImage = match[1] === "!";
    label = match[2];
    keySource = match[3] ? match[3] : match[2];
  } else {
    match = SHORT_REF_RE.exec(source);
    if (!match) return null;
    isImage = match[1] === "!";
    label = match[2];
    keySource = match[2];
  }
  if (tagSwallowsBracket(source, label, isImage ? 2 : 1)) return null;
  const entry = ctx.refs[labelKey(keySource)];
  if (!entry) {
    return { k: "text", raw: source.charAt(0), text: source.charAt(0), rawBlock: false };
  }
  return makeLinkToken(label, entry.href, entry.title, match[0], isImage, ctx);
}

// Match a raw HTML tag (or comment / PI / CDATA) inline, tracking the
// two pieces of context marked maintains: whether we are inside an
// anchor, and whether we are inside a raw-text element.
function parseTagToken(source, ctx) {
  const match = HTML_TAG_RE.exec(source);
  if (!match) return null;
  const raw = match[0];
  if (!ctx.inLink && ANCHOR_OPEN_RE.test(raw)) ctx.inLink = true;
  else if (ctx.inLink && ANCHOR_CLOSE_RE.test(raw)) ctx.inLink = false;
  if (!ctx.inRawBlock && RAW_OPEN_RE.test(raw)) ctx.inRawBlock = true;
  else if (ctx.inRawBlock && RAW_CLOSE_RE.test(raw)) ctx.inRawBlock = false;
  return { k: "html", raw };
}

// ---------------------------------------------------------------------
// Emphasis, strikethrough and autolink matchers
// ---------------------------------------------------------------------

// Attempt an <em>/<strong> starting at the current position. `masked`
// and `offset` locate the run inside the masked source, `prevChar` is
// the effective preceding character, and `closers` bounds the search.
function parseEmphasis(rest, masked, offset, prevChar, ctx, closers) {
  const opener = EM_OPEN_RE.exec(rest);
  if (!opener) return null;
  if (!opener[1] && !opener[2] && !opener[3] && !opener[4]) return null;
  const delim = rest.charAt(0);
  const prevIsDelim = prevChar === delim;
  // Walk back to the start of the delimiter run in the masked text.
  let runStart = offset;
  while (runStart > 0 && masked.charAt(runStart - 1) === delim) runStart--;
  let before = "";
  if (runStart > 0) {
    const slice = masked.slice(Math.max(0, runStart - 2), runStart);
    const points = [...slice];
    before = points.length ? points[points.length - 1] : "";
  }
  const beforeIsFlanking =
    before === "*" || before === "_" || (before !== "" && PUNCT_OR_SPACE_TEST.test(before));
  let effectivePrev = prevChar;
  if (runStart < offset) effectivePrev = before;
  const prevOk =
    runStart < offset
      ? beforeIsFlanking
      : effectivePrev !== "" && PUNCT_OR_SPACE_TEST.test(effectivePrev);
  if (opener[4] && effectivePrev !== "" && ALNUM_TEST.test(effectivePrev)) return null;
  const punctAfter = opener[1] || opener[3] || "";
  if (!(punctAfter === "" || effectivePrev === "" || prevOk)) return null;
  const runLength = [...opener[0]].length - 1;
  let openCount = runLength;
  let skipped = 0;
  const runTotal = offset - runStart + runLength;
  const midWord = before.trim() !== "" && (punctAfter !== "" || (delim === "*" && !beforeIsFlanking));
  const lastCloser = closers[delim];
  const afterOpener = offset + runLength;
  if (lastCloser < afterOpener) return null;
  const tail = masked.slice(afterOpener);
  const limit = lastCloser - afterOpener;
  const closerRe = delim === "*" ? EM_CLOSE_AST_RE : EM_CLOSE_UND_RE;
  closerRe.lastIndex = 0;
  let hit;
  while ((hit = closerRe.exec(tail)) !== null) {
    if (hit.index > limit) break;
    const group = hit[1] || hit[2] || hit[3] || hit[4] || hit[5] || hit[6];
    if (!group) continue;
    let closerLen = [...group].length;
    if (hit[3] || hit[4]) { openCount += closerLen; continue; }
    if (hit[5] || hit[6] || midWord) {
      if (prevIsDelim && (hit[5] || hit[6])) break;
      // The rule of three: opener/closer lengths that would both be
      // multiples of three cannot pair unless the sum is not.
      if (runTotal % 3 !== 0 && (runTotal + closerLen) % 3 === 0) { skipped += closerLen; continue; }
    }
    openCount -= closerLen;
    if (openCount > 0) continue;
    closerLen = Math.min(closerLen, closerLen + openCount + skipped);
    const headLen = [...hit[0]][0].length;
    const raw = rest.slice(0, runLength + hit.index + headLen + closerLen);
    if (Math.min(runLength, closerLen) % 2 === 1) {
      return { k: "em", raw, tokens: tokenizeInline(raw.slice(1, -1), ctx) };
    }
    return { k: "strong", raw, tokens: tokenizeInline(raw.slice(2, -2), ctx) };
  }
  return null;
}

// Attempt a GFM strikethrough span ("~x~" or "~~x~~").
function parseStrikethrough(rest, masked, offset, prevChar, ctx, closers) {
  const opener = DEL_OPEN_RE.exec(rest);
  if (!opener) return null;
  const punctAfter = opener[1] || "";
  if (!(punctAfter === "" || prevChar === "" || PUNCT_OR_SPACE_TEST.test(prevChar))) return null;
  const runLength = [...opener[0]].length - 1;
  let openCount = runLength;
  const lastCloser = closers["~"];
  const afterOpener = offset + runLength;
  if (lastCloser < afterOpener) return null;
  const tail = masked.slice(afterOpener);
  const limit = lastCloser - afterOpener;
  DEL_CLOSE_RE.lastIndex = 0;
  let hit;
  while ((hit = DEL_CLOSE_RE.exec(tail)) !== null) {
    if (hit.index > limit) break;
    const group = hit[1] || hit[2] || hit[3] || hit[4] || hit[5] || hit[6];
    if (!group) continue;
    let closerLen = [...group].length;
    if (closerLen !== runLength) continue;
    if (hit[3] || hit[4]) { openCount += closerLen; continue; }
    openCount -= closerLen;
    if (openCount > 0) continue;
    closerLen = Math.min(closerLen, closerLen + openCount);
    const headLen = [...hit[0]][0].length;
    const raw = rest.slice(0, runLength + hit.index + headLen + closerLen);
    const inner = raw.slice(runLength, raw.length - runLength);
    return { k: "del", raw, tokens: tokenizeInline(inner, ctx) };
  }
  return null;
}

// "<scheme:...>" and "<user@host>" autolinks.
function parseAngleAutolink(rest) {
  const match = ANGLE_AUTOLINK_RE.exec(rest);
  if (!match) return null;
  const text = match[1];
  const isEmail = !/^[a-zA-Z][a-zA-Z0-9+.-]{1,31}:/.test(text);
  return {
    k: "link", raw: match[0], href: isEmail ? "mailto:" + text : text, title: null, text,
    autolink: true, tokens: [{ k: "text", raw: text, text, rawBlock: false }],
  };
}

// GFM bare autolinks in running text (www., protocol URLs, emails).
function parseBareUrl(rest) {
  const match = BARE_URL_RE.exec(rest);
  if (!match) return null;
  if (match[3] !== undefined) {
    return {
      k: "link", raw: match[0], href: "mailto:" + match[0], title: null, text: match[0],
      autolink: true, tokens: [{ k: "text", raw: match[0], text: match[0], rawBlock: false }],
    };
  }
  let text = match[0];
  let previous;
  do {
    previous = text;
    const trimmed = URL_TRIM_RE.exec(text);
    text = trimmed ? trimmed[0] : "";
  } while (previous !== text);
  if (text === "") return null;
  return {
    k: "link", raw: text, href: match[1] === "www." ? "http://" + text : text, title: null, text,
    autolink: true, tokens: [{ k: "text", raw: text, text, rawBlock: false }],
  };
}

// ---------------------------------------------------------------------
// Plain-text consumption
//
// Most of any document is plain text. The scanner below swallows the
// longest run that cannot start another inline construct, checking
// candidate stop positions with small lookup tables instead of
// regexes: special characters, protocol prefixes, "www." hosts,
// mailto:/xmpp: prefixes, email starts and hard-break space runs.
// ---------------------------------------------------------------------

const EMAIL_LOCAL_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.!#$%&'*+/=?^_`{|}~-";
const EMAIL_LOCAL_TABLE = (() => {
  const table = new Uint8Array(128);
  for (let i = 0; i < EMAIL_LOCAL_CHARS.length; i++) table[EMAIL_LOCAL_CHARS.charCodeAt(i)] = 1;
  return table;
})();

function looksLikeEmailStart(rest, from) {
  const at = rest.indexOf("@", from);
  if (at === -1 || at === from) return false;
  for (let j = from; j < at; j++) {
    const code = rest.charCodeAt(j);
    if (code >= 128 || EMAIL_LOCAL_TABLE[code] === 0) return false;
  }
  return true;
}

const INLINE_STOP_TABLE = (() => {
  const table = new Uint8Array(128);
  for (const ch of ["\\", "<", "!", "[", "`", "*", "~", "_"]) table[ch.charCodeAt(0)] = 1;
  return table;
})();

function isAlnumCode(code) {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function looksLikeProtocol(rest, at) {
  const ch = rest.charAt(at);
  if (ch === "h" || ch === "H") {
    if (
      (rest.charAt(at + 1) === "t" || rest.charAt(at + 1) === "T") &&
      (rest.charAt(at + 2) === "t" || rest.charAt(at + 2) === "T") &&
      (rest.charAt(at + 3) === "p" || rest.charAt(at + 3) === "P")
    ) {
      let j = at + 4;
      if (rest.charAt(j) === "s" || rest.charAt(j) === "S") j++;
      return rest.charAt(j) === ":" && rest.charAt(j + 1) === "/" && rest.charAt(j + 2) === "/";
    }
    return false;
  }
  if (ch === "f" || ch === "F") {
    return (
      (rest.charAt(at + 1) === "t" || rest.charAt(at + 1) === "T") &&
      (rest.charAt(at + 2) === "p" || rest.charAt(at + 2) === "P") &&
      rest.charAt(at + 3) === ":" && rest.charAt(at + 4) === "/" && rest.charAt(at + 5) === "/"
    );
  }
  return false;
}

function consumePlainText(rest, ctx) {
  const length = rest.length;
  let i;
  const first = rest.charAt(0);
  if (first === "`" || first === "~") {
    i = 1;
    while (i < length && rest.charAt(i) === first) i++;
  } else {
    i = 1;
  }
  const unitEnd = i;
  let prevCode = rest.charCodeAt(i - 1);
  while (i < length) {
    const code = rest.charCodeAt(i);
    if (code < 128 && INLINE_STOP_TABLE[code] === 1) break;
    if (code === 32) {
      // Two or more spaces before a newline form a hard break; the
      // run must stop before them (unless it just started there).
      let spaces = 0;
      while (rest.charAt(i + spaces) === " ") spaces++;
      if (spaces >= 2 && rest.charAt(i + spaces) === "\n") {
        if (prevCode !== 32 || i === unitEnd) break;
        prevCode = 32;
        i++;
        continue;
      }
    } else if (code === 104 || code === 72 || code === 102 || code === 70) {
      if (looksLikeProtocol(rest, i)) break;
    } else if (code === 119 && rest.startsWith("www.", i)) {
      const before = rest.charAt(i - 1);
      if (
        before === "" || before === " " || before === "\t" || before === "\n" || before === "\r" ||
        before === "\f" || before === "\v" || before === "*" || before === "_" || before === "~" || before === "("
      ) break;
    } else if (
      (code === 109 || code === 120) &&
      (rest.startsWith("mailto:", i) || rest.startsWith("xmpp:", i)) &&
      !(i === unitEnd && unitEnd > 1) &&
      !isAlnumCode(prevCode)
    ) {
      break;
    }
    if (
      code < 128 && EMAIL_LOCAL_TABLE[code] === 1 &&
      (i === unitEnd || prevCode >= 128 || EMAIL_LOCAL_TABLE[prevCode] === 0) &&
      looksLikeEmailStart(rest, i)
    ) break;
    prevCode = code;
    i++;
  }
  const rawText = rest.slice(0, i);
  return {
    k: "text", raw: rawText,
    text: ctx.inRawBlock ? rawText : decodeCharRefs(rawText),
    rawBlock: ctx.inRawBlock, fromText: true,
  };
}

// ---------------------------------------------------------------------
// The inline lexer: dispatch on the first character, in the same
// priority order marked uses, falling back to plain text.
// ---------------------------------------------------------------------

function tokenizeInline(source, ctx) {
  const savedParenFlag = ctx.parenPossible;
  ctx.parenPossible = savedParenFlag && source.indexOf(")") !== -1;
  try {
    return tokenizeInlineBody(source, ctx);
  } finally {
    ctx.parenPossible = savedParenFlag;
  }
}

function tokenizeInlineBody(source, ctx) {
  const needsMask = source.indexOf("*") !== -1 || source.indexOf("_") !== -1 || source.indexOf("~") !== -1;
  const masked = needsMask ? buildDelimMask(source, ctx.refs) : source;
  const closers = needsMask ? computeLastClosers(masked) : { "*": -1, _: -1, "~": -1 };
  const tokens = [];
  let pos = 0;
  let prevChar = "";
  let prevWasText = false;
  while (pos < source.length) {
    const rest = source.slice(pos);
    const effectivePrev = prevWasText ? prevChar : "";
    let token = null;
    const head = rest.charAt(0);
    // Fast path: an ordinary character is either a bare autolink or
    // the start of a plain-text run.
    if (
      head !== "\\" && head !== "<" && head !== "!" && head !== "[" && head !== "`" &&
      head !== "*" && head !== "_" && head !== "~" && head !== " "
    ) {
      if (!ctx.inLink) {
        const code = rest.charCodeAt(0);
        if (code < 128 && EMAIL_LOCAL_TABLE[code] === 1) token = parseBareUrl(rest);
      }
      if (!token) token = consumePlainText(rest, ctx);
    }
    if (!token && head === "\\") {
      const escaped = BACKSLASH_ESCAPE_RE.exec(rest);
      if (escaped) token = { k: "escape", raw: escaped[0], text: escaped[1] };
    }
    if (!token && head === "<") token = parseTagToken(rest, ctx);
    if (!token && (head === "[" || head === "!")) {
      if (ctx.parenPossible) token = parseInlineLink(rest, ctx);
      if (!token) token = parseRefLink(rest, ctx);
    }
    if (!token && (head === "*" || head === "_")) {
      token = parseEmphasis(rest, masked, pos, effectivePrev, ctx, closers);
    }
    if (!token && head === "`") {
      const span = matchCodeSpan(rest);
      if (span) token = { k: "codespan", raw: span.raw, text: span.text };
    }
    if (!token && (head === " " || head === "\\")) {
      const br = HARD_BREAK_RE.exec(rest);
      if (br) token = { k: "br", raw: br[0] };
    }
    if (!token && head === "~") token = parseStrikethrough(rest, masked, pos, effectivePrev, ctx, closers);
    if (!token && head === "<") token = parseAngleAutolink(rest);
    if (!token && !ctx.inLink) {
      const code = rest.charCodeAt(0);
      if (code < 128 && EMAIL_LOCAL_TABLE[code] === 1) token = parseBareUrl(rest);
    }
    if (!token) token = consumePlainText(rest, ctx);
    if (!token || token.raw.length === 0) {
      token = {
        k: "text", raw: rest.charAt(0),
        text: ctx.inRawBlock ? rest.charAt(0) : decodeCharRefs(rest.charAt(0)),
        rawBlock: ctx.inRawBlock, fromText: true,
      };
    }
    tokens.push(token);
    pos += token.raw.length;
    if (token.fromText) {
      prevWasText = true;
      if (!token.raw.endsWith("_")) prevChar = token.raw.charAt(token.raw.length - 1);
    } else {
      prevWasText = false;
    }
  }
  return tokens;
}

// Render inline tokens to HTML. With `textOnly` set, markup is
// stripped and only the textual content remains (used for image alt
// text, where marked renders the label as plain text).
function renderInlineTokens(tokens, textOnly) {
  let out = "";
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    switch (token.k) {
      case "text":
        out += textOnly ? token.text : token.rawBlock ? token.text : escapeHtml(token.text, false);
        break;
      case "escape":
        out += textOnly ? token.text : escapeHtml(token.text, false);
        break;
      case "html":
        out += token.raw;
        break;
      case "codespan":
        out += textOnly ? token.text : "<code>" + escapeHtml(token.text, true) + "</code>";
        break;
      case "br":
        out += textOnly ? "" : "<br>";
        break;
      case "strong":
        out += textOnly
          ? renderInlineTokens(token.tokens, true)
          : "<strong>" + renderInlineTokens(token.tokens, false) + "</strong>";
        break;
      case "em":
        out += textOnly
          ? renderInlineTokens(token.tokens, true)
          : "<em>" + renderInlineTokens(token.tokens, false) + "</em>";
        break;
      case "del":
        out += textOnly
          ? renderInlineTokens(token.tokens, true)
          : "<del>" + renderInlineTokens(token.tokens, false) + "</del>";
        break;
      case "link": {
        if (textOnly) {
          out += renderInlineTokens(token.tokens, true);
        } else {
          const inner = token.autolink ? escapeHtml(token.text, true) : renderInlineTokens(token.tokens, false);
          const destination = cleanUrl(token.href);
          if (destination === null) {
            out += inner;
          } else {
            let tag = '<a href="' + escapeHtml(destination, token.autolink) + '"';
            if (token.title) tag += ' title="' + escapeHtml(token.title, false) + '"';
            out += tag + ">" + inner + "</a>";
          }
        }
        break;
      }
      case "image": {
        const alt = renderInlineTokens(token.tokens, true);
        if (textOnly) {
          out += alt;
        } else {
          const destination = cleanUrl(token.href);
          if (destination === null) {
            out += escapeHtml(alt, false);
          } else {
            let tag = '<img src="' + escapeHtml(destination, false) + '" alt="' + escapeHtml(alt, false) + '"';
            if (token.title) tag += ' title="' + escapeHtml(token.title, false) + '"';
            out += tag + ">";
          }
        }
        break;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------
// Block-level patterns and single-construct consumers
// ---------------------------------------------------------------------

const ESCAPED_PUNCT_RE = /\\([\p{P}\p{S}])/gu;
const ATX_HEADING_RE = /^ {0,3}(#{1,6})(?=[ \t\n]|$)/;
const FENCE_START_RE = /^ {0,3}(`{3,}|~{3,})/;
const LIST_MARKER_RE = /^ {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|\n|$)/;
const LIST_PARA_START_RE = /^ {0,3}(?:[*+-]|1[.)])[ \t]+[^ \t\n]/;
const QUOTE_START_RE = /^ {0,3}>/;
const TABLE_DELIM_LINE_RE = /^ {0,3}((?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?)$/;

function lineIsBlank(line) {
  return BLANK_LINE_RE.test(line);
}

// A thematic break: at least three of the same "-", "_" or "*"
// characters, with only spaces/tabs interleaved.
function lineIsHr(line) {
  let i = 0;
  while (i < 3 && line[i] === " ") i++;
  const ch = line[i];
  if (ch !== "-" && ch !== "_" && ch !== "*") return false;
  let count = 0;
  for (; i < line.length; i++) {
    const c = line[i];
    if (c === ch) count++;
    else if (c !== " " && c !== "\t") return false;
  }
  return count >= 3;
}

function lineIsFence(line) {
  const match = FENCE_START_RE.exec(line);
  if (!match) return false;
  if (match[1][0] === "`" && line.indexOf("`", match[0].length) !== -1) return false;
  return true;
}

// Split a table row into cells. Escaped pipes ("\|") do not split;
// they are hidden behind a sentinel before splitting, then restored.
function splitTableRow(text, columnCount) {
  let staged = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "|") {
      let backslashes = 0;
      for (let p = i - 1; p >= 0 && text[p] === "\\"; p--) backslashes++;
      staged += backslashes % 2 === 1 ? "|" : "\x01";
    } else {
      staged += ch;
    }
  }
  let cells = staged.split("\x01");
  if (!cells[0].trim()) cells.shift();
  if (cells.length > 0 && !cells[cells.length - 1].trim()) cells.pop();
  if (columnCount !== undefined) {
    if (cells.length > columnCount) cells.splice(columnCount);
    while (cells.length < columnCount) cells.push("");
  }
  return cells.map((cell) => cell.trim().replace(/\\\|/g, "|"));
}

// Validate a header line + delimiter line pair as a GFM table head.
// The delimiter's cell count must agree with the header's.
function matchTableHeader(headerLine, delimLine) {
  if (delimLine === undefined) return null;
  const headerMatch = /^ *([^\n ].*)$/.exec(headerLine);
  if (!headerMatch) return null;
  const delimMatch = TABLE_DELIM_LINE_RE.exec(delimLine);
  if (!delimMatch) return null;
  if (!/[:|]/.test(delimMatch[1])) return null;
  const delimCells = delimMatch[1].replace(/^\||\| *$/g, "").split("|");
  const aligns = delimCells.map((cell) => {
    if (/^ *-+: *$/.test(cell)) return "right";
    if (/^ *:-+: *$/.test(cell)) return "center";
    if (/^ *:-+ *$/.test(cell)) return "left";
    return null;
  });
  const header = splitTableRow(headerMatch[1]);
  if (header.length !== aligns.length) return null;
  return { header, aligns };
}

// Consume a run of blank lines (a "space" token in marked terms).
function consumeBlankLines(source) {
  let pos = 0;
  while (pos < source.length) {
    const nl = source.indexOf("\n", pos);
    const lineEnd = nl === -1 ? source.length : nl;
    if (!BLANK_LINE_RE.test(source.slice(pos, lineEnd))) break;
    pos = nl === -1 ? source.length : nl + 1;
    if (nl === -1) break;
  }
  if (pos === 0) return null;
  return { raw: source.slice(0, pos), rawLen: pos };
}

// Remove one level of code indentation (a tab, or up to four spaces)
// from every line of an indented code block.
function dedentCodeBlock(text) {
  return text.split("\n").map((line) => {
    const tabbed = /^ {0,3}\t/.exec(line);
    if (tabbed) return line.slice(tabbed[0].length);
    const spaced = /^ {1,4}/.exec(line);
    if (spaced) return line.slice(spaced[0].length);
    return line;
  }).join("\n");
}

// Consume an indented code block: consecutive lines indented by four
// spaces (or a tab), with blank lines absorbed into the block.
function consumeIndentedCode(source) {
  let pos = 0;
  let units = 0;
  while (pos < source.length) {
    let probe = pos;
    let spaces = 0;
    while (source[probe] === " ") { spaces++; probe++; }
    let indentEnd = -1;
    if (source[probe] === "\t" && spaces <= 3) indentEnd = probe + 1;
    else if (spaces >= 4) indentEnd = pos + 4;
    if (indentEnd === -1) break;
    const nl = source.indexOf("\n", indentEnd);
    const lineEnd = nl === -1 ? source.length : nl;
    if (lineEnd === indentEnd) break;
    pos = lineEnd;
    units++;
    if (source[pos] === "\n") {
      // Swallow following blank lines; the block continues if more
      // indented content follows them.
      let ahead = pos + 1;
      while (ahead < source.length) {
        const nl2 = source.indexOf("\n", ahead);
        const end2 = nl2 === -1 ? source.length : nl2;
        if (!BLANK_LINE_RE.test(source.slice(ahead, end2))) break;
        ahead = nl2 === -1 ? source.length : nl2 + 1;
        if (nl2 === -1) break;
      }
      pos = ahead;
    }
  }
  if (units === 0) return null;
  const raw = source.slice(0, pos);
  return { text: dedentCodeBlock(trimBlankTail(raw)), rawLen: pos };
}

// Consume a fenced code block (``` or ~~~), returning its content and
// language info string. An unterminated fence runs to end of input.
function consumeFence(source) {
  let i = 0;
  while (i < 3 && source[i] === " ") i++;
  const marker = source[i];
  if (marker !== "`" && marker !== "~") return null;
  let runEnd = i;
  while (source[runEnd] === marker) runEnd++;
  const runLength = runEnd - i;
  if (runLength < 3) return null;
  const nl = source.indexOf("\n", runEnd);
  const firstLineEnd = nl === -1 ? source.length : nl;
  const info = source.slice(runEnd, firstLineEnd);
  if (marker === "`" && info.indexOf("`") !== -1) return null;
  const indentText = source.slice(0, i);
  const contentStart = nl === -1 ? source.length : nl + 1;
  let pos = contentStart;
  let contentEnd = source.length;
  let rawLen = source.length;
  let closed = false;
  while (pos <= source.length) {
    const lineNl = source.indexOf("\n", pos);
    const lineEnd = lineNl === -1 ? source.length : lineNl;
    const line = source.slice(pos, lineEnd);
    let j = 0;
    while (j < 3 && line[j] === " ") j++;
    if (line[j] === marker) {
      let r = j;
      while (line[r] === marker) r++;
      if (r - j >= runLength && /^ *$/.test(line.slice(r))) {
        contentEnd = pos;
        rawLen = lineEnd;
        closed = true;
        break;
      }
    }
    if (lineNl === -1) break;
    pos = lineNl + 1;
  }
  if (!closed) { contentEnd = source.length; rawLen = source.length; }
  let content = source.slice(contentStart, contentEnd);
  if (content.endsWith("\n")) content = content.slice(0, -1);
  if (marker === "`" && indentText.length > 0) {
    // Backtick fences strip up to the fence's own indent from content.
    content = content.split("\n").map((line) => {
      const lead = /^[ \t]+/.exec(line);
      if (!lead) return line;
      return line.slice(Math.min(lead[0].length, indentText.length));
    }).join("\n");
  }
  const lang = info.trim().replace(ESCAPED_PUNCT_RE, "$1");
  return { text: content, lang, rawLen };
}

// Consume an ATX heading line ("# ..." through "###### ..."),
// stripping an optional closing run of hashes.
function consumeAtxHeading(source) {
  const nl = source.indexOf("\n");
  const line = nl === -1 ? source : source.slice(0, nl);
  const match = ATX_HEADING_RE.exec(line);
  if (!match) return null;
  let text = line.slice(match[0].length).trim();
  if (/#$/.test(text)) {
    const stripped = text.slice(0, text.length - trailingRun(text, "#"));
    if (stripped === "" || /[ \t]$/.test(stripped)) text = stripped.trim();
  }
  return { tok: { t: "heading", depth: match[1].length, text }, rawLen: line.length };
}

// Consume a thematic-break line.
function consumeHr(source) {
  const nl = source.indexOf("\n");
  const line = nl === -1 ? source : source.slice(0, nl);
  if (!lineIsHr(line)) return null;
  return { rawLen: line.length };
}

// Lazy line view over a source string: lines are split on demand and
// cached, so a matcher that only inspects the first lines of a
// construct never pays to split the remainder.
function createLineCursor(source) {
  const cache = [];
  let pos = 0;
  let exhausted = false;
  return {
    get(index) {
      while (!exhausted && cache.length <= index) {
        if (pos >= source.length) { exhausted = true; break; }
        const nl = source.indexOf("\n", pos);
        if (nl === -1) {
          cache.push({ text: source.slice(pos), start: pos, end: source.length, next: source.length });
          pos = source.length;
          exhausted = true;
        } else {
          cache.push({ text: source.slice(pos, nl), start: pos, end: nl, next: nl + 1 });
          pos = nl + 1;
        }
      }
      return cache[index];
    },
  };
}

// ---------------------------------------------------------------------
// Blockquotes
//
// A quote gathers its ">"-prefixed lines plus any lazy continuation
// lines. The gathered lines are then processed in chunks: each chunk
// is stripped of its markers and re-lexed as blocks. Chunking matters
// because a lazy line that follows a completed inner block (for
// example a list) may extend that block rather than starting fresh
// inline content, so the last inner token is given a chance to grow.
// ---------------------------------------------------------------------

function stripQuoteMarkers(text) {
  let inner = text.replace(/^( {0,3}>)([ \t]+)/gm, (whole, prefix, ws) => prefix + expandLeadingTabs(ws, prefix.length));
  inner = inner.replace(/\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g, "\n    $1");
  inner = inner.replace(/^ {0,3}>[ \t]?/gm, "");
  return inner;
}

function consumeBlockquote(source, ctx) {
  const cursor = createLineCursor(source);
  const firstLine = cursor.get(0);
  if (!firstLine || !QUOTE_START_RE.test(firstLine.text)) return null;
  const gathered = [];
  let lazyAllowed = false;
  for (let index = 0; ; index++) {
    const line = cursor.get(index);
    if (!line) break;
    if (QUOTE_START_RE.test(line.text)) {
      gathered.push(line);
      const content = line.text.replace(/^ {0,3}> ?/, "");
      lazyAllowed = !BLANK_LINE_RE.test(content);
      continue;
    }
    if (!lazyAllowed) break;
    if (line.text === "" || (BLANK_LINE_RE.test(line.text) && line.next > line.end)) break;
    if (
      lineIsHr(line.text) || ATX_HEADING_RE.test(line.text) || lineIsFence(line.text) ||
      LIST_MARKER_RE.test(line.text) || HTML_BLOCK_START_RE.test(line.text) || QUOTE_START_RE.test(line.text)
    ) break;
    gathered.push(line);
  }
  if (gathered.length === 0) return null;
  const innerTokens = [];
  let index = 0;
  while (index < gathered.length) {
    const chunk = [];
    let seenMarker = false;
    while (index < gathered.length) {
      const line = gathered[index];
      const hasMarker = QUOTE_START_RE.test(line.text);
      if (!hasMarker && seenMarker) break;
      if (hasMarker) seenMarker = true;
      chunk.push(line);
      index++;
    }
    const innerSource = stripQuoteMarkers(chunk.map((l) => l.text).join("\n"));
    lexIntoList(innerSource, { refs: ctx.refs, top: true }, true, innerTokens);
    if (index >= gathered.length) break;
    const lastToken = innerTokens[innerTokens.length - 1];
    if (!lastToken) break;
    if (
      lastToken.t === "code" || lastToken.t === "heading" || lastToken.t === "hr" ||
      lastToken.t === "html" || lastToken.t === "table"
    ) break;
    if (lastToken.t === "blockquote") {
      const remaining = gathered.slice(index);
      const combined =
        lastToken.rawText + "\n" +
        remaining.map((l) => l.text).join("\n").replace(/^ {0,3}>[ \t]?/gm, "");
      const regrown = consumeBlockquote(combined, ctx);
      if (regrown && regrown.tok.lineCount > lastToken.lineCount) {
        innerTokens[innerTokens.length - 1] = regrown.tok;
        index += regrown.tok.lineCount - lastToken.lineCount;
        continue;
      }
      break;
    }
    if (lastToken.t === "list") {
      const remaining = gathered.slice(index);
      const combined = lastToken.rawText + "\n" + remaining.map((l) => l.text).join("\n");
      const regrown = consumeList(combined, ctx);
      if (regrown) {
        let extra = 0;
        if (regrown.tok.rawText.length > lastToken.rawText.length) {
          extra = regrown.tok.rawText.slice(lastToken.rawText.length + 1).split("\n").length;
        }
        innerTokens[innerTokens.length - 1] = regrown.tok;
        index += extra;
        continue;
      }
      break;
    }
  }
  if (index === 0) return null;
  const rawText = gathered.slice(0, index).map((l) => l.text).join("\n");
  return { tok: { t: "blockquote", toks: innerTokens, rawText, lineCount: index }, rawLen: gathered[index - 1].end };
}

// ---------------------------------------------------------------------
// Lists
//
// Items are collected one marker at a time. Each item's content is
// dedented by the width its marker establishes, and continuation lines
// are absorbed until a line starts a sibling item or interrupts the
// item (heading, fence, quote, HTML block or thematic break at the
// item's indent level). Loose/tight is decided from blank lines
// between items and inside items, exactly as marked decides it, and
// GFM task-list checkboxes are recognised on the first line.
// ---------------------------------------------------------------------

const indentPatternCache = new Map();

// Build (and cache) the "starts at this indent" pattern used to test
// whether a continuation line begins a given block construct.
function indentPattern(kind, indent) {
  const key = kind + ":" + indent;
  const cached = indentPatternCache.get(key);
  if (cached) return cached;
  const prefix = "^ {0," + Math.max(0, Math.min(3, indent - 1)) + "}";
  let pattern;
  if (kind === "bullet") pattern = new RegExp(prefix + "(?:[*+-]|\\d{1,9}[.)])((?:[\\t ][^\\n]*)?(?:\\n|$))");
  else if (kind === "hr") pattern = new RegExp(prefix + "((?:-[ \\t]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)");
  else if (kind === "fence") pattern = new RegExp(prefix + "(?:```|~~~)");
  else if (kind === "heading") pattern = new RegExp(prefix + "#{1,6}(?:\\s|$)");
  else if (kind === "html") pattern = new RegExp(prefix + "(?:</?(?:" + BLOCK_TAG_NAMES + ")(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)", "i");
  else if (kind === "quote") pattern = new RegExp(prefix + ">");
  else pattern = /$^/;
  indentPatternCache.set(key, pattern);
  return pattern;
}

const LIST_FIRST_ITEM_RE = /^ {0,3}([*+-]|\d{1,9}[.)])([ \t][^\n]*?)?(?:\n|$)/;
const TASK_ITEM_RE = /^\[[ xX]\][ \t]+\S/;
const TASK_PREFIX_RE = /^\[[ xX]\][ \t]+/;
const TASK_BOX_SEARCH_RE = /\[[ xX]\]/;
const itemPatternCache = new Map();

function endsWithBlankLinePair(text) {
  let i = text.length - 1;
  while (i >= 0 && (text[i] === " " || text[i] === "\t")) i--;
  if (i < 0 || text[i] !== "\n") return false;
  i--;
  while (i >= 0 && (text[i] === " " || text[i] === "\t")) i--;
  return i >= 0 && text[i] === "\n";
}

function consumeList(source, ctx) {
  const firstMatch = LIST_FIRST_ITEM_RE.exec(source);
  if (!firstMatch) return null;
  const bullet = firstMatch[1];
  const ordered = bullet.length > 1;
  const startNumber = ordered ? parseInt(bullet.slice(0, -1), 10) : "";
  const bulletPattern = ordered ? "\\d{1,9}\\" + bullet.charAt(bullet.length - 1) : "\\" + bullet;
  let itemRe = itemPatternCache.get(bulletPattern);
  if (!itemRe) {
    itemRe = new RegExp("^( {0,3}" + bulletPattern + ")((?:[\\t ][^\\n]*)?(?:\\n|$))");
    itemPatternCache.set(bulletPattern, itemRe);
  }
  const items = [];
  let rest = source;
  let loose = false;
  let pendingLoose = false;
  while (rest.length > 0) {
    if (consumeHr(rest)) break;
    const itemMatch = itemRe.exec(rest);
    if (!itemMatch) break;
    const itemStart = source.length - rest.length;
    rest = rest.substring(itemMatch[0].length);
    const bulletWidth = itemMatch[1].length;
    const firstNl = itemMatch[2].indexOf("\n");
    let firstLine = firstNl === -1 ? itemMatch[2] : itemMatch[2].slice(0, firstNl);
    const firstChar = firstLine.charAt(0);
    if (firstChar === " " || firstChar === "\t") {
      firstLine = firstLine.replace(/^[ \t]+/, (ws) => expandLeadingTabs(ws, bulletWidth));
    }
    const startsBlank = firstLine.trim() === "";
    let indent;
    let text;
    if (startsBlank) {
      indent = bulletWidth + 1;
      text = "";
    } else {
      let spaces = 0;
      while (firstLine.charAt(spaces) === " ") spaces++;
      if (spaces > 4) spaces = 1;
      text = firstLine.slice(spaces);
      indent = spaces + bulletWidth;
    }
    let blankConsumed = false;
    if (startsBlank) {
      const nl = rest.indexOf("\n");
      const nextLine = nl === -1 ? rest : rest.slice(0, nl);
      if (BLANK_LINE_RE.test(nextLine)) {
        rest = rest.substring(nextLine.length + 1);
        blankConsumed = true;
      }
    }
    if (!blankConsumed) {
      const bulletRe = indentPattern("bullet", indent);
      const hrRe = indentPattern("hr", indent);
      const fenceRe = indentPattern("fence", indent);
      const headingRe = indentPattern("heading", indent);
      const htmlRe = indentPattern("html", indent);
      const quoteRe = indentPattern("quote", indent);
      let prevLine = firstLine;
      let wasBlank = startsBlank;
      while (rest.length > 0) {
        const nl = rest.indexOf("\n");
        const line = nl === -1 ? rest : rest.slice(0, nl);
        const leadChar = line.charAt(0);
        const expanded = leadChar === " " || leadChar === "\t"
          ? line.replace(/^[ \t]+/, (ws) => expandLeadingTabs(ws, 0))
          : line;
        let spaces = 0;
        while (line.charAt(spaces) === " ") spaces++;
        const contentChar = line.charAt(spaces);
        let interrupts = false;
        if (spaces <= indent - 1 && contentChar !== "") {
          if (contentChar === "#") interrupts = headingRe.test(line);
          else if (contentChar === ">") interrupts = quoteRe.test(line);
          else if (contentChar === "`" || contentChar === "~") interrupts = fenceRe.test(line);
          else if (contentChar === "<") interrupts = htmlRe.test(line);
          else if (contentChar === "_" || contentChar === "*") interrupts = hrRe.test(line) || bulletRe.test(line);
          else if (contentChar === "-" || contentChar === "+") interrupts = bulletRe.test(line) || hrRe.test(line);
          else if (contentChar >= "0" && contentChar <= "9") interrupts = bulletRe.test(line);
        }
        if (interrupts) break;
        let firstNonSpace = 0;
        while (expanded.charAt(firstNonSpace) === " ") firstNonSpace++;
        if (expanded.charAt(firstNonSpace) === "") firstNonSpace = -1;
        if ((firstNonSpace !== -1 && firstNonSpace >= indent) || !line.trim()) {
          text += "\n" + expanded.slice(indent);
        } else {
          if (
            wasBlank ||
            (prevLine.indexOf("\t") === -1 ? prevLine.search(/[^ ]/) : prevLine.replace(/\t/g, "    ").search(/[^ ]/)) >= 4 ||
            fenceRe.test(prevLine) || headingRe.test(prevLine) || htmlRe.test(prevLine) || hrRe.test(prevLine)
          ) break;
          let addition = line;
          if (/^ {0,3}(?:=+|-+) *$/.test(line) && consumeSetextHeading(prevLine + "\n" + line + "\n")) {
            addition = "    " + expanded.replace(/^ {0,3}/, "");
          }
          text += "\n" + addition;
        }
        wasBlank = !line.trim();
        rest = nl === -1 ? "" : rest.substring(nl + 1);
        prevLine = expanded.slice(indent);
      }
    }
    const itemRaw = source.slice(itemStart, source.length - rest.length);
    if (!loose) {
      if (pendingLoose) loose = true;
      else if (endsWithBlankLinePair(itemRaw)) pendingLoose = true;
    }
    items.push({ text, raw: itemRaw, task: false, checked: false, toks: null });
  }
  if (items.length === 0) return null;
  const finalItem = items[items.length - 1];
  finalItem.raw = finalItem.raw.trimEnd();
  finalItem.text = finalItem.text.trimEnd();
  const consumedLength = source.length - rest.length;
  const rawLen = source.slice(0, consumedLength).trimEnd().length;
  for (const item of items) {
    item.toks = lexBlockList(item.text, { refs: ctx.refs, top: false }, false);
    if (TASK_ITEM_RE.test(item.text)) item.task = true;
  }
  if (!loose) {
    for (const item of items) {
      for (const token of item.toks) {
        if (token.t === "space" && token.raw.indexOf("\n") !== token.raw.lastIndexOf("\n")) { loose = true; break; }
      }
      if (loose) break;
    }
  }
  if (loose) {
    // In a loose list, bare text blocks render as paragraphs.
    for (const item of items) {
      for (const token of item.toks) {
        if (token.t === "text") token.t = "paragraph";
      }
    }
  }
  for (const item of items) {
    if (!item.task) continue;
    item.text = item.text.replace(TASK_PREFIX_RE, "");
    const box = TASK_BOX_SEARCH_RE.exec(item.raw);
    item.checked = box ? box[0] !== "[ ]" : false;
    const head = item.toks[0];
    if (head && (head.t === "text" || head.t === "paragraph")) {
      head.text = head.text.replace(TASK_PREFIX_RE, "");
      if (loose) { head.checkbox = item.checked; continue; }
    } else if (loose) {
      item.toks.unshift({ t: "paragraph", text: "", checkbox: item.checked, checkboxOnly: true });
      continue;
    }
    item.toks.unshift({ t: "checkbox", checked: item.checked });
  }
  const listRawText = source.slice(0, rawLen);
  return {
    tok: { t: "list", ordered, start: startNumber, loose, items, rawText: listRawText, lineCount: listRawText.split("\n").length },
    rawLen,
  };
}

// ---------------------------------------------------------------------
// HTML blocks
//
// The seven CommonMark HTML block kinds, in marked's order: raw-text
// elements (script/pre/style/textarea) run to their closing tag,
// comments to "-->", processing instructions to "?>", declarations
// and CDATA to ">", and tag-based blocks to the next blank line.
// ---------------------------------------------------------------------

const SCRIPT_BLOCK_RE = /^ {0,3}<(script|pre|style|textarea)[\s>]/i;
const COMMENT_BLOCK_RE = /^ {0,3}<!--/;
const PI_BLOCK_RE = /^ {0,3}<\?/;
const DECL_BLOCK_RE = /^ {0,3}<![A-Z]/;
const CDATA_BLOCK_RE = /^ {0,3}<!\[CDATA\[/;
const BLOCK_TAG_BLOCK_RE = new RegExp("^ {0,3}</?(" + BLOCK_TAG_NAMES + ")(?: +|\\n|/?>|$)", "i");
const ANY_TAG_BLOCK_RE = new RegExp(
  "^ {0,3}<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?: +[a-zA-Z:_][\\w.:-]*(?: *= *\"[^\"\\n]*\"| *= *'[^'\\n]*'| *= *[^\\s\"'=<>`]+)?)*? */?>(?=[ \\t]*(?:\\n|$))",
  "i"
);
const CLOSE_TAG_BLOCK_RE = /^ {0,3}<\/[a-z][a-z0-9-]*\s*>(?=[ \t]*(?:\n|$))/i;
const BLANK_RUN_RE = /(?:\n[ \t]*)+\n/;

function scanToBlankLine(source) {
  const match = BLANK_RUN_RE.exec(source);
  return match ? match.index + match[0].length : source.length;
}

function consumeHtmlBlock(source) {
  let match;
  if ((match = SCRIPT_BLOCK_RE.exec(source))) {
    const tagName = match[1].toLowerCase();
    const lowered = source.toLowerCase();
    const closeAt = lowered.indexOf("</" + tagName, match[0].length);
    let raw;
    if (closeAt === -1) {
      raw = source;
    } else {
      const nl = source.indexOf("\n", closeAt);
      const lineEnd = nl === -1 ? source.length : nl;
      let end = lineEnd;
      while (source[end] === "\n") end++;
      raw = source.slice(0, end);
    }
    const text = trimBlankTail(raw);
    return { text, rawLen: text.length, pre: tagName !== "textarea" };
  }
  if (COMMENT_BLOCK_RE.test(source)) {
    let end;
    if (source.startsWith("<!-->", source.indexOf("<!--"))) {
      end = source.indexOf("<!-->") + 5;
    } else {
      const close = source.indexOf("-->", 4);
      end = close === -1 ? source.length : close + 3;
    }
    const nl = source.indexOf("\n", end);
    const lineEnd = nl === -1 ? source.length : nl;
    let stop = lineEnd;
    while (source[stop] === "\n") stop++;
    const text = trimBlankTail(source.slice(0, stop));
    return { text, rawLen: text.length, pre: false };
  }
  if (PI_BLOCK_RE.test(source)) {
    const close = source.indexOf("?>", 2);
    let raw;
    if (close === -1) raw = source;
    else {
      const nl = source.indexOf("\n", close + 2);
      const lineEnd = nl === -1 ? source.length : nl;
      let stop = lineEnd;
      while (source[stop] === "\n") stop++;
      raw = source.slice(0, stop);
    }
    const text = trimBlankTail(raw);
    return { text, rawLen: text.length, pre: false };
  }
  if (CDATA_BLOCK_RE.test(source)) {
    const close = source.indexOf("]]>", 2);
    let raw;
    if (close === -1) raw = source;
    else {
      const nl = source.indexOf("\n", close + 3);
      const lineEnd = nl === -1 ? source.length : nl;
      let stop = lineEnd;
      while (source[stop] === "\n") stop++;
      raw = source.slice(0, stop);
    }
    const text = trimBlankTail(raw);
    return { text, rawLen: text.length, pre: false };
  }
  if (DECL_BLOCK_RE.test(source)) {
    const close = source.indexOf(">", 2);
    let raw;
    if (close === -1) raw = source;
    else {
      const nl = source.indexOf("\n", close + 1);
      const lineEnd = nl === -1 ? source.length : nl;
      let stop = lineEnd;
      while (source[stop] === "\n") stop++;
      raw = source.slice(0, stop);
    }
    const text = trimBlankTail(raw);
    return { text, rawLen: text.length, pre: false };
  }
  if (BLOCK_TAG_BLOCK_RE.test(source) || ANY_TAG_BLOCK_RE.test(source) || CLOSE_TAG_BLOCK_RE.test(source)) {
    const raw = source.slice(0, scanToBlankLine(source));
    const text = trimBlankTail(raw);
    return { text, rawLen: text.length, pre: false };
  }
  return null;
}

// ---------------------------------------------------------------------
// Link reference definitions: "[label]: destination "title""
// Parsed by hand so the label/destination/title boundaries follow
// marked exactly (including the fallback where a would-be title that
// is followed by junk invalidates the title but not the definition).
// ---------------------------------------------------------------------

function consumeLinkDef(source) {
  let i = 0;
  while (i < 3 && source[i] === " ") i++;
  if (source[i] !== "[") return null;
  if (/^\s*\]/.test(source.slice(i + 1))) return null;
  let j = i + 1;
  let labelEnd = -1;
  while (j < source.length) {
    const ch = source[j];
    if (ch === "\\") { j += 2; continue; }
    if (ch === "[") return null;
    if (ch === "]") { labelEnd = j; break; }
    if (ch === "\n") {
      let ahead = j + 1;
      while (source[ahead] === " " || source[ahead] === "\t") ahead++;
      if (ahead >= source.length || source[ahead] === "\n") return null;
    }
    j++;
  }
  if (labelEnd === -1) return null;
  const label = source.slice(i + 1, labelEnd);
  if (label.length === 0) return null;
  j = labelEnd + 1;
  if (source[j] !== ":") return null;
  j++;
  while (source[j] === " ") j++;
  if (source[j] === "\n") {
    j++;
    while (source[j] === " " || source[j] === "\t") j++;
  }
  let hrefRaw;
  if (source[j] === "<") {
    let ahead = j + 1;
    while (ahead < source.length && source[ahead] !== ">" && source[ahead] !== "\n") ahead++;
    if (source[ahead] !== ">") return null;
    hrefRaw = source.slice(j, ahead + 1);
    j = ahead + 1;
  } else {
    if (j >= source.length || /[\s<]/.test(source[j])) return null;
    let ahead = j;
    while (ahead < source.length && !/\s/.test(source[ahead])) ahead++;
    hrefRaw = source.slice(j, ahead);
    j = ahead;
    if (parenBalance(hrefRaw, "(", ")") !== -1) return null;
  }
  const afterHref = j;
  let titleRaw;
  {
    let ahead = j;
    while (source[ahead] === " ") ahead++;
    let separated = ahead > j;
    if (source[ahead] === "\n") {
      separated = true;
      ahead++;
      while (source[ahead] === " " || source[ahead] === "\t") ahead++;
    }
    if (separated && (source[ahead] === '"' || source[ahead] === "'" || source[ahead] === "(")) {
      const openQuote = source[ahead];
      const closeQuote = openQuote === "(" ? ")" : openQuote;
      let end = ahead + 1;
      let valid = false;
      while (end < source.length) {
        const ch = source[end];
        if (ch === "\\") { end += 2; continue; }
        if (openQuote === "(" && ch === "(") break;
        if (openQuote === "'" && ch === "\n") {
          if (source[end + 1] === "\n") break;
        }
        if (ch === closeQuote) { valid = true; break; }
        end++;
      }
      if (valid) { titleRaw = source.slice(ahead, end + 1); j = end + 1; }
    }
  }
  while (source[j] === " ") j++;
  if (j < source.length && source[j] !== "\n") {
    if (titleRaw === undefined) return null;
    // Trailing junk after the title: drop the title, keep the def —
    // but only if the line then ends cleanly after the destination.
    titleRaw = undefined;
    j = afterHref;
    while (source[j] === " ") j++;
    if (j < source.length && source[j] !== "\n") return null;
  }
  const href = hrefRaw.replace(/^<(.*)>$/, "$1").replace(ESCAPED_PUNCT_RE, "$1");
  const title = titleRaw ? titleRaw.slice(1, -1).replace(ESCAPED_PUNCT_RE, "$1") : undefined;
  return { tag: labelKey(label), href, title, rawText: source.slice(0, j), rawLen: j };
}

// ---------------------------------------------------------------------
// Tables, setext headings and paragraphs
// ---------------------------------------------------------------------

function consumeTable(source) {
  const cursor = createLineCursor(source);
  const headLine = cursor.get(0);
  const delimLine = cursor.get(1);
  if (!headLine || !delimLine) return null;
  const head = matchTableHeader(headLine.text, delimLine.text);
  if (!head) return null;
  const rows = [];
  let rawLen = delimLine.end;
  for (let index = 2; ; index++) {
    const lineObj = cursor.get(index);
    if (!lineObj) break;
    const line = lineObj.text;
    if (/^ *$/.test(line)) break;
    if (
      lineIsHr(line) || ATX_HEADING_RE.test(line) || QUOTE_START_RE.test(line) ||
      lineIsFence(line) || LIST_MARKER_RE.test(line) || HTML_BLOCK_START_RE.test(line) ||
      /^(?: {4}| {0,3}\t)[^\n]/.test(line)
    ) break;
    rows.push(splitTableRow(line, head.header.length));
    rawLen = lineObj.end;
  }
  return { tok: { t: "table", head: head.header, aligns: head.aligns, rows }, rawLen };
}

function consumeSetextHeading(source) {
  const cursor = createLineCursor(source);
  const firstObj = cursor.get(0);
  if (!firstObj || !cursor.get(1)) return null;
  const first = firstObj.text;
  if (lineIsBlank(first)) return null;
  if (
    LIST_MARKER_RE.test(first) || /^(?: {4}| {0,3}\t)/.test(first) || lineIsFence(first) ||
    QUOTE_START_RE.test(first) || ATX_HEADING_RE.test(first) ||
    /^ {0,3}<[^\n>]+>$/.test(first) || /^ {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*$/.test(first)
  ) return null;
  const textLines = [first];
  for (let index = 1; ; index++) {
    const lineObj = cursor.get(index);
    if (!lineObj) break;
    const line = lineObj.text;
    const underline = /^ {0,3}(=+|-+)[ \t]*$/.exec(line);
    if (underline) {
      const text = textLines.join("\n").trim();
      return { tok: { t: "heading", depth: underline[1][0] === "=" ? 1 : 2, text }, rawLen: lineObj.end };
    }
    const nextObj = cursor.get(index + 1);
    if (
      lineIsBlank(line) || lineIsHr(line) || ATX_HEADING_RE.test(line) || QUOTE_START_RE.test(line) ||
      lineIsFence(line) || LIST_MARKER_RE.test(line) || /^ {0,3}<[^\n>]+>$/.test(line) ||
      matchTableHeader(line, nextObj ? nextObj.text : undefined)
    ) return null;
    textLines.push(line);
  }
  return null;
}

// Paragraph interruption only needs the *shape* of a table: marked's
// paragraph pattern embeds the delimiter-line pattern without
// checking that header and delimiter cell counts agree (that strict
// check belongs to the table tokeniser). A mismatched pair therefore
// still ends the paragraph even though no table is produced.
function looseTableShape(line, nextLine) {
  if (nextLine === undefined) return false;
  if (!/^ *([^\n ].*)$/.test(line)) return false;
  return TABLE_DELIM_LINE_RE.test(nextLine);
}

function consumeParagraph(source) {
  const cursor = createLineCursor(source);
  const firstObj = cursor.get(0);
  if (!firstObj || lineIsBlank(firstObj.text)) return null;
  const textLines = [firstObj.text];
  let rawLen = firstObj.end;
  for (let index = 1; ; index++) {
    const lineObj = cursor.get(index);
    if (!lineObj) break;
    if (lineObj.text === "") break;
    if (BLANK_LINE_RE.test(lineObj.text) && lineObj.next > lineObj.end) break;
    const lineText = lineObj.text;
    const nextObj = cursor.get(index + 1);
    if (
      lineIsHr(lineText) || ATX_HEADING_RE.test(lineText) || QUOTE_START_RE.test(lineText) ||
      lineIsFence(lineText) || LIST_PARA_START_RE.test(lineText) || HTML_BLOCK_START_RE.test(lineText) ||
      looseTableShape(lineText, nextObj ? nextObj.text : undefined)
    ) break;
    textLines.push(lineText);
    rawLen = lineObj.end;
  }
  return { tok: { t: "paragraph", text: textLines.join("\n") }, rawLen };
}

// ---------------------------------------------------------------------
// The block lexer driver
//
// Constructs are attempted in marked's precedence order. Before each
// attempt, the first non-space character of the remaining source is
// inspected so matchers whose opener cannot possibly match are
// skipped entirely — this first-character dispatch is a large part of
// the speed advantage on ordinary prose documents.
// ---------------------------------------------------------------------

function lexBlockList(source, ctx, mergeParagraphs) {
  const tokens = [];
  lexIntoList(source, ctx, mergeParagraphs, tokens);
  return tokens;
}

// Character following up to three leading spaces — the anchor point
// every block opener cares about.
function firstContentChar(source) {
  let i = 0;
  while (i < 3 && source[i] === " ") i++;
  return source[i];
}

function lexIntoList(source, ctx, mergeParagraphs, tokens) {
  let rest = source;
  while (rest.length > 0) {
    const blanks = consumeBlankLines(rest);
    if (blanks) {
      rest = rest.slice(blanks.rawLen);
      if (blanks.raw.length === 1 && tokens.length > 0) {
        // A lone newline after a raw-text token extends that token
        // instead of becoming a space token of its own.
        const previous = tokens[tokens.length - 1];
        if (previous.rawText !== undefined) {
          previous.rawText += "\n";
          previous.lineCount = previous.rawText.split("\n").length;
        }
      } else {
        tokens.push({ t: "space", raw: blanks.raw });
      }
      continue;
    }
    const previous = tokens[tokens.length - 1];
    const head = firstContentChar(rest);
    const indented = rest[0] === " " || rest[0] === "\t" ? consumeIndentedCode(rest) : null;
    if (indented) {
      rest = rest.slice(indented.rawLen);
      if (previous && (previous.t === "paragraph" || previous.t === "text")) {
        previous.text += "\n" + indented.text;
      } else {
        tokens.push({ t: "code", text: indented.text, lang: "" });
      }
      continue;
    }
    const fence = head === "`" || head === "~" ? consumeFence(rest) : null;
    if (fence) {
      rest = rest.slice(fence.rawLen);
      tokens.push({ t: "code", text: fence.text, lang: fence.lang });
      continue;
    }
    const heading = head === "#" ? consumeAtxHeading(rest) : null;
    if (heading) {
      rest = rest.slice(heading.rawLen);
      tokens.push(heading.tok);
      continue;
    }
    const hr = head === "-" || head === "_" || head === "*" ? consumeHr(rest) : null;
    if (hr) {
      rest = rest.slice(hr.rawLen);
      tokens.push({ t: "hr" });
      continue;
    }
    const quote = head === ">" ? consumeBlockquote(rest, ctx) : null;
    if (quote) {
      rest = rest.slice(quote.rawLen);
      tokens.push(quote.tok);
      continue;
    }
    const list =
      head === "*" || head === "+" || head === "-" || (head >= "0" && head <= "9")
        ? consumeList(rest, ctx)
        : null;
    if (list) {
      rest = rest.slice(list.rawLen);
      tokens.push(list.tok);
      continue;
    }
    const html = head === "<" ? consumeHtmlBlock(rest) : null;
    if (html) {
      rest = rest.slice(html.rawLen);
      tokens.push({ t: "html", text: html.text });
      continue;
    }
    const definition = head === "[" ? consumeLinkDef(rest) : null;
    if (definition) {
      rest = rest.slice(definition.rawLen);
      if (previous && (previous.t === "paragraph" || previous.t === "text")) {
        previous.text += "\n" + definition.rawText;
      } else {
        if (!Object.prototype.hasOwnProperty.call(ctx.refs, definition.tag)) {
          ctx.refs[definition.tag] = { href: definition.href, title: definition.title };
        }
        tokens.push({ t: "def" });
      }
      continue;
    }
    const table = consumeTable(rest);
    if (table) {
      rest = rest.slice(table.rawLen);
      tokens.push(table.tok);
      continue;
    }
    const setext = consumeSetextHeading(rest);
    if (setext) {
      rest = rest.slice(setext.rawLen);
      tokens.push(setext.tok);
      continue;
    }
    if (ctx.top) {
      const paragraph = consumeParagraph(rest);
      if (paragraph) {
        rest = rest.slice(paragraph.rawLen);
        if (mergeParagraphs && previous && previous.t === "paragraph") {
          previous.text += "\n" + paragraph.tok.text;
        } else {
          tokens.push(paragraph.tok);
        }
        continue;
      }
    }
    // Fallback: emit the current line as a bare text token (this is
    // how non-top-level contexts, e.g. list items, hold plain text).
    const nl = rest.indexOf("\n");
    const line = nl === -1 ? rest : rest.slice(0, nl);
    if (line.length === 0) { rest = rest.slice(1); continue; }
    rest = rest.slice(line.length);
    if (previous && previous.t === "text") previous.text += "\n" + line;
    else tokens.push({ t: "text", text: line });
  }
}

// ---------------------------------------------------------------------
// Block rendering
// ---------------------------------------------------------------------

function checkboxMarkup(checked) {
  return "<input " + (checked ? 'checked="" ' : "") + 'disabled="" type="checkbox"> ';
}

function renderBlockTokens(tokens, shared) {
  let out = "";
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.t === "space" || token.t === "def") {
      continue;
    } else if (token.t === "hr") {
      out += "<hr>\n";
    } else if (token.t === "heading") {
      out += "<h" + token.depth + ">" + renderInlineShared(token.text, shared) + "</h" + token.depth + ">\n";
    } else if (token.t === "code") {
      const language = (token.lang || "").match(/^\S*/)[0];
      let body = token.text ? token.text.replace(/\n$/, "") + "\n" : "";
      body = escapeHtml(body, true);
      out += language
        ? '<pre><code class="language-' + escapeHtml(language, false) + '">' + body + "</code></pre>\n"
        : "<pre><code>" + body + "</code></pre>\n";
    } else if (token.t === "blockquote") {
      out += "<blockquote>\n" + renderBlockTokens(token.toks, shared) + "</blockquote>\n";
    } else if (token.t === "list") {
      const tagName = token.ordered ? "ol" : "ul";
      const startAttr = token.ordered && token.start !== 1 ? ' start="' + token.start + '"' : "";
      out += "<" + tagName + startAttr + ">\n";
      for (const item of token.items) out += "<li>" + renderBlockTokens(item.toks, shared) + "</li>\n";
      out += "</" + tagName + ">\n";
    } else if (token.t === "checkbox") {
      out += checkboxMarkup(token.checked);
    } else if (token.t === "html") {
      out += token.text;
    } else if (token.t === "paragraph") {
      out += "<p>" + (token.checkbox !== undefined ? checkboxMarkup(token.checkbox) : "") + renderInlineShared(token.text, shared) + "</p>\n";
    } else if (token.t === "text") {
      out += renderInlineShared(token.text, shared);
    } else if (token.t === "table") {
      out += "<table>\n<thead>\n<tr>\n";
      for (let c = 0; c < token.head.length; c++) {
        const align = token.aligns[c];
        out += align ? '<th align="' + align + '">' : "<th>";
        out += renderInlineShared(token.head[c], shared);
        out += "</th>\n";
      }
      out += "</tr>\n</thead>\n";
      if (token.rows.length > 0) {
        out += "<tbody>";
        for (const row of token.rows) {
          out += "<tr>\n";
          for (let c = 0; c < row.length; c++) {
            const align = token.aligns[c];
            out += align ? '<td align="' + align + '">' : "<td>";
            out += renderInlineShared(row[c], shared);
            out += "</td>\n";
          }
          out += "</tr>\n";
        }
        out += "</tbody>";
      }
      out += "</table>\n";
    }
  }
  return out;
}

// Render one inline source string with the shared per-document
// context (reference table plus the transient in-link / raw flags).
function renderInlineShared(text, shared) {
  shared.inRawBlock = false;
  return renderInlineTokens(tokenizeInline(text, shared), false);
}

// Public entry point: render a Markdown document to HTML, byte-for-
// byte identical to marked 18.1.3 with default options.
export function parse(markdown) {
  const source = markdown.replace(/\r\n|\r/g, "\n");
  const refs = {};
  const tokens = lexBlockList(source, { refs, top: true }, false);
  const shared = { refs, inLink: false, inRawBlock: false, linkEmitted: false, parenPossible: true };
  return renderBlockTokens(tokens, shared);
}
