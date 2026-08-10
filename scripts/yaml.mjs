/**
 * A deliberately small, strict YAML subset parser — enough for a project policy and nothing more.
 *
 * Why hand-written: this repository has zero third-party dependencies, and CI has no install step
 * (ADR 0006). Why *strict*: an under-validating parser is a false green.
 * A permissive parser that silently misreads `expires: 2026-12-31` as a Date, or
 * quietly ignores an anchor, would report a policy as valid that means something other than what its
 * author wrote. So every construct outside the supported subset is a hard error, not a best guess.
 *
 * Supported:  nested block mappings (2-space indent), block sequences of mappings, scalars
 *             (bare, single- or double-quoted), empty inline sequence `[]`, `#` comments, blank
 *             lines.
 * Rejected:   tabs, anchors/aliases (`&`/`*`), block scalars (`|`/`>`), flow collections with
 *             content (`{...}`/`[a, b]`), documents (`---`), merge keys, duplicate keys,
 *             inconsistent indentation.
 *
 * Every scalar is returned as a string. Type coercion belongs to the schema, not the parser — the
 * schema declares `standardVersion` is a string matching a semver pattern, and a parser that turned
 * `1.0` into a number would defeat that check before it ran.
 */

export class YamlError extends Error {
  constructor(message, line) {
    super(line === undefined ? message : `line ${line}: ${message}`);
    this.name = "YamlError";
    this.line = line;
  }
}

const REJECTED = [
  [/^\s*---/, "document markers (`---`) are not supported"],
  [/^\s*<<\s*:/, "merge keys (`<<:`) are not supported"],
];

/** Strip a trailing `#` comment, respecting quotes. Returns the code part of the line. */
function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === "#" && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
}

/** Parse a scalar. Quoted values keep their contents verbatim; bare values are trimmed. */
function parseScalar(raw, lineNo) {
  const value = raw.trim();
  if (value === "") return "";
  const first = value[0];
  if (first === '"' || first === "'") {
    if (value.length < 2 || value[value.length - 1] !== first) {
      throw new YamlError("unterminated quoted string", lineNo);
    }
    const inner = value.slice(1, -1);
    if (inner.includes(first)) {
      throw new YamlError("escaped or nested quotes are not supported", lineNo);
    }
    return inner;
  }
  if (first === "&" || first === "*") {
    throw new YamlError("anchors and aliases are not supported", lineNo);
  }
  if (first === "|" || first === ">") {
    throw new YamlError("block scalars are not supported", lineNo);
  }
  if (first === "{") throw new YamlError("flow mappings are not supported", lineNo);
  if (first === "[") {
    if (value.replace(/\s/g, "") !== "[]") {
      throw new YamlError("flow sequences with content are not supported", lineNo);
    }
    return [];
  }
  return value;
}

/** Split `key: value`, respecting quotes in the key. Returns null when there is no top-level colon. */
function splitKey(text) {
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === ":" && (i + 1 === text.length || /\s/.test(text[i + 1]))) {
      return [text.slice(0, i), text.slice(i + 1)];
    }
  }
  return null;
}

/** Tokenize into significant lines carrying indent, content, and 1-based line number. */
function tokenize(text) {
  const lines = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    const lineNo = index + 1;
    if (raw.includes("\t")) throw new YamlError("tabs are not permitted for indentation", lineNo);
    for (const [pattern, message] of REJECTED) {
      if (pattern.test(raw)) throw new YamlError(message, lineNo);
    }
    const code = stripComment(raw);
    if (code.trim() === "") return;
    const indent = code.length - code.trimStart().length;
    if (indent % 2 !== 0) {
      throw new YamlError(`indentation must be a multiple of 2 spaces (found ${indent})`, lineNo);
    }
    lines.push({ indent, text: code.trim(), lineNo });
  });
  return lines;
}

/** Parse a block at `indent`, starting at `lines[start]`. Returns [value, nextIndex]. */
function parseBlock(lines, start, indent) {
  if (lines[start].text.startsWith("- ") || lines[start].text === "-") {
    return parseSequence(lines, start, indent);
  }
  return parseMapping(lines, start, indent);
}

function parseSequence(lines, start, indent) {
  const items = [];
  let i = start;
  while (i < lines.length && lines[i].indent === indent) {
    const line = lines[i];
    if (!line.text.startsWith("- ") && line.text !== "-") break;
    const inline = line.text === "-" ? "" : line.text.slice(2).trim();
    if (inline === "") throw new YamlError("empty sequence entries are not supported", line.lineNo);

    const pair = splitKey(inline);
    if (!pair) {
      // A scalar sequence entry.
      items.push(parseScalar(inline, line.lineNo));
      i++;
      continue;
    }
    // A mapping entry: its first key sits on the dash line, the rest are indented beneath.
    const entryIndent = indent + 2;
    const synthetic = [{ indent: entryIndent, text: inline, lineNo: line.lineNo }];
    let j = i + 1;
    while (j < lines.length && lines[j].indent >= entryIndent) {
      synthetic.push(lines[j]);
      j++;
    }
    const [value, consumed] = parseMapping(synthetic, 0, entryIndent);
    if (consumed !== synthetic.length) {
      throw new YamlError("could not parse sequence entry", line.lineNo);
    }
    items.push(value);
    i = j;
  }
  return [items, i];
}

function parseMapping(lines, start, indent) {
  const map = {};
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (line.indent < indent) break;
    if (line.indent > indent) {
      throw new YamlError(`unexpected indentation (expected ${indent} spaces)`, line.lineNo);
    }
    if (line.text.startsWith("- ")) break;

    const pair = splitKey(line.text);
    if (!pair) throw new YamlError(`expected 'key: value' but found '${line.text}'`, line.lineNo);
    const key = parseScalar(pair[0], line.lineNo);
    if (typeof key !== "string" || key === "") {
      throw new YamlError("empty or non-scalar keys are not supported", line.lineNo);
    }
    if (Object.prototype.hasOwnProperty.call(map, key)) {
      throw new YamlError(`duplicate key '${key}'`, line.lineNo);
    }

    const rest = pair[1].trim();
    if (rest !== "") {
      map[key] = parseScalar(rest, line.lineNo);
      i++;
      continue;
    }

    // No inline value: a nested block must follow at a deeper indent, or the value is empty.
    const next = lines[i + 1];
    if (!next || next.indent <= indent) {
      map[key] = null;
      i++;
      continue;
    }
    // A block sequence under a key may sit at the key's own indent or one level deeper; both are
    // conventional YAML. A nested mapping must be exactly one level deeper.
    const isSequence = next.text === "-" || next.text.startsWith("- ");
    if (isSequence) {
      if (next.indent !== indent && next.indent !== indent + 2) {
        throw new YamlError("sequence must be at the key's indent or 2 spaces deeper", next.lineNo);
      }
    } else if (next.indent !== indent + 2) {
      throw new YamlError("nested block must be indented by 2 spaces", next.lineNo);
    }
    const childIndent = next.indent;
    const [value, consumed] = parseBlock(lines, i + 1, childIndent);
    map[key] = value;
    i = consumed;
  }
  return [map, i];
}

/** Parse a YAML document from the supported subset. Throws YamlError on anything else. */
export function parseYaml(text) {
  const lines = tokenize(text);
  if (lines.length === 0) return {};
  if (lines[0].indent !== 0) throw new YamlError("document must start at column 0", lines[0].lineNo);
  const [value, consumed] = parseBlock(lines, 0, 0);
  if (consumed !== lines.length) {
    throw new YamlError("unexpected content after the document", lines[consumed].lineNo);
  }
  return value;
}
