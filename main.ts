// mend - one patch tool for every AI edit format.
// Reads unified diffs, SEARCH/REPLACE blocks, V4A patches and JSON edit
// lists, matches old lines at three drift tiers, and writes all or nothing.
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMAT_NAMES = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class ParseFault {
  line: string;
  constructor(line: string) { this.line = line; }
}
class EditFault {
  code: string;
  path: string;
  constructor(code: string, path: string) { this.code = code; this.path = path; }
}

function isBlankText(s: string): boolean { return s.trim() === ''; }

function splitPatchText(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (text.endsWith('\n')) parts.pop();
  return parts.map((p) => (p.endsWith('\r') ? p.slice(0, -1) : p));
}

function pathIsSafe(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}
function demandSafe(p: string): void {
  if (!pathIsSafe(p)) throw new EditFault('unsafe', p);
}

interface FileParts { lines: string[]; br: string; ends: boolean; }
function splitFileText(text: string): FileParts {
  if (text === '') return { lines: [], br: '\n', ends: false };
  const firstNl = text.indexOf('\n');
  const br = firstNl > 0 && text[firstNl - 1] === '\r' ? '\r\n' : '\n';
  const ends = text.endsWith(br);
  const lines = text.split(br);
  if (ends) lines.pop();
  return { lines, br, ends };
}
function joinFileText(lines: string[], br: string, ends: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (ends ? br : '');
}

// Tree holds the virtual state after edits so far.
class VirtualTree {
  private cache = new Map<string, string | null>();
  changed = new Map<string, string | null>();
  moves: Array<[string, string]> = [];
  before(p: string): string | null {
    if (!this.cache.has(p)) {
      let value: string | null = null;
      try { if (statSync(p).isFile()) value = readFileSync(p, 'utf8'); } catch { value = null; }
      this.cache.set(p, value);
    }
    return this.cache.get(p)!;
  }
  current(p: string): string | null {
    return this.changed.has(p) ? this.changed.get(p)! : this.before(p);
  }
}

type EditFn = (tree: VirtualTree, strict: boolean) => void;

// ---- tiered line matching ----
function lineAtTier(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}
function sliceMatches(fileLines: string[], at: number, oldLines: string[], tier: number): boolean {
  for (let k = 0; k < oldLines.length; k++) {
    if (lineAtTier(fileLines[at + k]!, tier) !== lineAtTier(oldLines[k]!, tier)) return false;
  }
  return true;
}
interface TierHit { tier: number; spots: number[]; }
function locateOld(fileLines: string[], oldLines: string[], strict: boolean, fromPos = 0): TierHit | null {
  const topTier = strict ? 0 : 2;
  for (let tier = 0; tier <= topTier; tier++) {
    const spots: number[] = [];
    for (let at = fromPos; at + oldLines.length <= fileLines.length; at++) {
      if (sliceMatches(fileLines, at, oldLines, tier)) spots.push(at);
    }
    if (spots.length > 0) return { tier, spots };
  }
  return null;
}
function locateSingle(fileLines: string[], anchor: string, strict: boolean, fromPos: number): TierHit | null {
  return locateOld(fileLines, [anchor], strict, fromPos);
}
function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}
interface OutEntry { isCtx: boolean; text: string; oldIndex: number; }
function renderReplacement(fileLines: string[], spot: number, oldLines: string[], entries: OutEntry[], tier: number): string[] {
  const out: string[] = [];
  const firstFileLead = oldLines.length > 0 ? leadingWs(fileLines[spot] ?? '') : '';
  const firstOldLead = oldLines.length > 0 ? leadingWs(oldLines[0] ?? '') : '';
  for (const e of entries) {
    if (e.isCtx) { out.push(fileLines[spot + e.oldIndex]!); continue; }
    let txt = e.text;
    if (tier === 2 && txt.trim() !== '') {
      if (firstOldLead === '') txt = firstFileLead + txt;
      else if (txt.startsWith(firstOldLead)) txt = firstFileLead + txt.slice(firstOldLead.length);
    }
    out.push(txt);
  }
  return out;
}
function renderPlain(fileLines: string[], spot: number, oldLines: string[], newLines: string[], tier: number): string[] {
  return renderReplacement(fileLines, spot, oldLines, newLines.map((t) => ({ isCtx: false, text: t, oldIndex: -1 })), tier);
}

// ---- JSON format ----
function buildJsonEdit(raw: unknown): EditFn | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const pth = obj.path;
  if (typeof pth !== 'string') return null;
  const needExisting = (tree: VirtualTree): string => {
    demandSafe(pth);
    const cur = tree.current(pth);
    if (cur === null) throw new EditFault('missing', pth);
    return cur;
  };
  if (obj.command === 'create' && typeof obj.file_text === 'string') {
    const content = obj.file_text;
    return (tree) => {
      demandSafe(pth);
      if (tree.current(pth) !== null) throw new EditFault('exists', pth);
      tree.changed.set(pth, content);
    };
  }
  if (obj.command === 'str_replace' && typeof obj.old_str === 'string' && obj.old_str !== '' && (obj.new_str === undefined || typeof obj.new_str === 'string')) {
    const needle = obj.old_str;
    const repl = (obj.new_str as string | undefined) ?? '';
    return (tree) => {
      const original = needExisting(tree);
      const nlAt = original.indexOf('\n');
      const isCrlf = nlAt > 0 && original[nlAt - 1] === '\r';
      const toLf = (s: string): string => (isCrlf ? s.split('\r\n').join('\n') : s);
      const hay = toLf(original);
      const ndl = toLf(needle);
      let hits = 0;
      for (let k = hay.indexOf(ndl); k >= 0; k = hay.indexOf(ndl, k + 1)) hits++;
      if (hits === 0) throw new EditFault('no-match', pth);
      if (hits > 1) throw new EditFault('ambiguous', pth);
      const at = hay.indexOf(ndl);
      const merged = hay.slice(0, at) + toLf(repl) + hay.slice(at + ndl.length);
      tree.changed.set(pth, isCrlf ? merged.split('\n').join('\r\n') : merged);
    };
  }
  if (obj.command === 'insert' && typeof obj.insert_line === 'number' && Number.isInteger(obj.insert_line) && typeof obj.new_str === 'string') {
    const lineNo = obj.insert_line;
    const added = splitPatchText(obj.new_str);
    return (tree) => {
      const original = needExisting(tree);
      const parts = splitFileText(original);
      if (lineNo < 0 || lineNo > parts.lines.length) throw new EditFault('no-match', pth);
      const next = [...parts.lines];
      next.splice(lineNo, 0, ...added);
      tree.changed.set(pth, joinFileText(next, parts.br, parts.ends));
    };
  }
  return null;
}
function parseJsonEdits(text: string, lines: string[]): EditFn[] {
  const firstIdx = lines.findIndex((l) => !isBlankText(l));
  if (firstIdx < 0) throw new ParseFault('error: parse 1');
  const list: EditFn[] = [];
  if (lines[firstIdx]!.trimStart().startsWith('[')) {
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { throw new ParseFault(`error: parse ${firstIdx + 1}`); }
    if (!Array.isArray(parsed)) throw new ParseFault(`error: parse ${firstIdx + 1}`);
    for (const item of parsed) {
      const e = buildJsonEdit(item);
      if (e === null) throw new ParseFault(`error: parse ${firstIdx + 1}`);
      list.push(e);
    }
    return list;
  }
  lines.forEach((line, idx) => {
    if (isBlankText(line)) return;
    let e: EditFn | null = null;
    try { e = buildJsonEdit(JSON.parse(line)); } catch { e = null; }
    if (e === null) throw new ParseFault(`error: parse ${idx + 1}`);
    list.push(e);
  });
  return list;
}

// ---- shared body model for unified and V4A ----
interface BodyLine { kind: 'ctx' | 'old' | 'new'; text: string; slash: boolean; blankRaw: boolean; }
function bodyOldLines(body: BodyLine[]): string[] {
  return body.filter((b) => b.kind !== 'new').map((b) => b.text);
}
function bodyNewEntries(body: BodyLine[]): OutEntry[] {
  const entries: OutEntry[] = [];
  let oldPos = -1;
  for (const b of body) {
    if (b.kind !== 'new') oldPos++;
    if (b.kind === 'ctx') entries.push({ isCtx: true, text: b.text, oldIndex: oldPos });
    else if (b.kind === 'new') entries.push({ isCtx: false, text: b.text, oldIndex: -1 });
  }
  return entries;
}
function slashAfterLastWrite(body: BodyLine[]): boolean {
  for (let k = body.length - 1; k >= 0; k--) {
    if (body[k]!.kind === 'ctx' || body[k]!.kind === 'new') return body[k]!.slash;
  }
  return false;
}

// ---- unified diffs ----
interface HunkData { startA: number; body: BodyLine[]; }
interface SectionData {
  byDiff: boolean;
  diffOld: string | null; diffNew: string | null;
  pairOld: string | null; pairNew: string | null; hasPair: boolean;
  renFrom: string | null; renTo: string | null;
  isNewFile: boolean; isDeletedFile: boolean;
  hunks: HunkData[];
}
function headerPathValue(line: string): string {
  let rest = line.slice(4);
  const tabAt = rest.indexOf('\t');
  if (tabAt >= 0) rest = rest.slice(0, tabAt);
  rest = rest.trim();
  if (rest === '/dev/null') return rest;
  if (rest.startsWith('a/') || rest.startsWith('b/')) rest = rest.slice(2);
  return rest;
}
function parseUnified(lines: string[]): EditFn[] {
  const sections: SectionData[] = [];
  let sec: SectionData | null = null;
  const freshSection = (byDiff: boolean): SectionData => ({
    byDiff, diffOld: null, diffNew: null, pairOld: null, pairNew: null, hasPair: false,
    renFrom: null, renTo: null, isNewFile: false, isDeletedFile: false, hunks: [],
  });
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      if (!m) throw new ParseFault(`error: parse ${i + 1}`);
      sec = freshSection(true);
      sec.diffOld = m[1]!; sec.diffNew = m[2]!;
      sections.push(sec);
      i++; continue;
    }
    if (line.startsWith('@@')) {
      if (sec === null) throw new ParseFault(`error: parse ${i + 1}`);
      const hm = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!hm) throw new ParseFault(`error: parse ${i + 1}`);
      const startA = parseInt(hm[1]!, 10);
      const body: BodyLine[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const bl = lines[j]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && j + 1 < lines.length && lines[j + 1]!.startsWith('+++ ')) break;
        if (bl === '') { body.push({ kind: 'ctx', text: '', slash: false, blankRaw: true }); j++; continue; }
        const ch = bl[0]!;
        if (ch === ' ') body.push({ kind: 'ctx', text: bl.slice(1), slash: false, blankRaw: false });
        else if (ch === '-') body.push({ kind: 'old', text: bl.slice(1), slash: false, blankRaw: false });
        else if (ch === '+') body.push({ kind: 'new', text: bl.slice(1), slash: false, blankRaw: false });
        else if (ch === '\\') { if (body.length > 0) body[body.length - 1]!.slash = true; j++; continue; }
        else break;
        j++;
      }
      while (body.length > 0 && body[body.length - 1]!.blankRaw) body.pop();
      sec.hunks.push({ startA, body });
      i = j; continue;
    }
    if (line.startsWith('--- ')) {
      const nextLine = i + 1 < lines.length ? lines[i + 1]! : '';
      if (nextLine.startsWith('+++ ')) {
        const o = headerPathValue(line);
        const n = headerPathValue(nextLine);
        if (sec !== null && !sec.hasPair && sec.hunks.length === 0 && sec.byDiff) {
          sec.pairOld = o; sec.pairNew = n; sec.hasPair = true;
        } else {
          sec = freshSection(false);
          sec.pairOld = o; sec.pairNew = n; sec.hasPair = true;
          sections.push(sec);
        }
        i += 2; continue;
      }
      if (sec !== null && sec.hunks.length === 0) throw new ParseFault(`error: parse ${i + 2}`);
      i++; continue;
    }
    if (sec !== null && sec.hunks.length === 0) {
      if (line.startsWith('rename from ')) sec.renFrom = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) sec.renTo = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) sec.isNewFile = true;
      else if (line.startsWith('deleted file mode')) sec.isDeletedFile = true;
    }
    i++;
  }
  if (sections.length === 0) throw new ParseFault('error: parse 1');
  return sections.map((s) => sectionToEdit(s));
}
function applyHunkList(parts: FileParts, hunks: HunkData[], strict: boolean, errPath: string): FileParts {
  let curLines = [...parts.lines];
  let curEnds = parts.ends;
  let delta = 0;
  for (const hunk of hunks) {
    const oldLines = bodyOldLines(hunk.body);
    const entries = bodyNewEntries(hunk.body);
    if (oldLines.length === 0) {
      const insertTexts = entries.map((e) => e.text);
      const atPos = Math.min(hunk.startA + delta, curLines.length);
      const wasEnd = atPos === curLines.length;
      curLines.splice(atPos, 0, ...insertTexts);
      if (wasEnd) curEnds = !slashAfterLastWrite(hunk.body);
      delta += insertTexts.length;
      continue;
    }
    const hit = locateOld(curLines, oldLines, strict);
    if (hit === null) throw new EditFault('no-match', errPath);
    const target = hunk.startA - 1 + delta;
    let chosen = hit.spots[0]!;
    let bestDist = Math.abs(chosen - target);
    for (const spot of hit.spots) {
      const dist = Math.abs(spot - target);
      if (dist < bestDist) { bestDist = dist; chosen = spot; }
    }
    const replacement = renderReplacement(curLines, chosen, oldLines, entries, hit.tier);
    const runsToEnd = chosen + oldLines.length === curLines.length;
    curLines.splice(chosen, oldLines.length, ...replacement);
    if (runsToEnd) curEnds = !slashAfterLastWrite(hunk.body);
    delta += replacement.length - oldLines.length;
  }
  return { lines: curLines, br: parts.br, ends: curEnds };
}
function sectionToEdit(s: SectionData): EditFn {
  return (tree, strict) => {
    let oldPath: string | null = null;
    let newPath: string | null = null;
    if (s.hasPair) { oldPath = s.pairOld; newPath = s.pairNew; }
    else if (s.renFrom !== null || s.renTo !== null) { oldPath = s.renFrom; newPath = s.renTo; }
    else { oldPath = s.diffOld; newPath = s.diffNew; }
    const creation = oldPath === '/dev/null' || s.isNewFile;
    const deletion = newPath === '/dev/null' || s.isDeletedFile;
    if (creation) {
      const dest = newPath === '/dev/null' ? oldPath : newPath;
      if (dest === null) throw new EditFault('missing', '');
      demandSafe(dest);
      if (tree.current(dest) !== null) throw new EditFault('exists', dest);
      const madeLines: string[] = [];
      let lastSlash = false;
      let seenPlus = false;
      for (const h of s.hunks) {
        for (const b of h.body) {
          if (b.kind === 'new') { madeLines.push(b.text); lastSlash = b.slash; seenPlus = true; }
        }
      }
      const content = madeLines.length === 0 ? '' : madeLines.join('\n') + (seenPlus && lastSlash ? '' : '\n');
      tree.changed.set(dest, content);
      return;
    }
    if (deletion) {
      const src = oldPath === '/dev/null' ? newPath : oldPath;
      if (src === null) throw new EditFault('missing', '');
      demandSafe(src);
      if (tree.current(src) === null) throw new EditFault('missing', src);
      tree.changed.set(src, null);
      return;
    }
    if (oldPath === null || newPath === null) throw new EditFault('missing', oldPath ?? newPath ?? '');
    demandSafe(oldPath);
    demandSafe(newPath);
    const moving = oldPath !== newPath;
    const existing = tree.current(oldPath);
    if (existing === null) throw new EditFault('missing', oldPath);
    if (moving && tree.current(newPath) !== null) throw new EditFault('exists', newPath);
    const parts = splitFileText(existing);
    const done = applyHunkList(parts, s.hunks, strict, oldPath);
    const output = joinFileText(done.lines, done.br, done.ends);
    if (moving) {
      tree.changed.set(oldPath, null);
      tree.changed.set(newPath, output);
      tree.moves.push([oldPath, newPath]);
    } else {
      tree.changed.set(oldPath, output);
    }
  };
}

// ---- SEARCH/REPLACE ----
function parseSearchReplace(lines: string[]): EditFn[] {
  const edits: EditFn[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') { i++; continue; }
    const searchIdx = i;
    let sepIdx = -1;
    for (let k = searchIdx + 1; k < lines.length; k++) {
      if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') break;
      if (lines[k]!.trimEnd() === '=======') { sepIdx = k; break; }
    }
    let repIdx = -1;
    if (sepIdx >= 0) {
      for (let k = sepIdx + 1; k < lines.length; k++) { if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') { repIdx = k; break; } }
    }
    if (sepIdx < 0 || repIdx < 0) throw new ParseFault(`error: parse ${searchIdx + 1}`);
    let foundPath: string | null = null;
    for (let k = searchIdx - 1; k > prevEnd; k--) {
      const cand = lines[k]!;
      if (isBlankText(cand)) continue;
      if (cand.trim().startsWith('```')) continue;
      foundPath = cand.trim();
      break;
    }
    const usePath = foundPath ?? prevPath;
    if (usePath === null) throw new ParseFault(`error: parse ${searchIdx + 1}`);
    const oldLines = lines.slice(searchIdx + 1, sepIdx);
    const newLines = lines.slice(sepIdx + 1, repIdx);
    const capturedPath = usePath;
    const capturedOld = oldLines;
    const capturedNew = newLines;
    edits.push((tree, strict) => {
      demandSafe(capturedPath);
      if (capturedOld.length === 0) {
        if (tree.current(capturedPath) !== null) throw new EditFault('exists', capturedPath);
        const content = capturedNew.length === 0 ? '' : capturedNew.join('\n') + '\n';
        tree.changed.set(capturedPath, content);
        return;
      }
      const existing = tree.current(capturedPath);
      if (existing === null) throw new EditFault('missing', capturedPath);
      const parts = splitFileText(existing);
      const hit = locateOld(parts.lines, capturedOld, strict);
      if (hit === null) throw new EditFault('no-match', capturedPath);
      if (hit.spots.length > 1) throw new EditFault('ambiguous', capturedPath);
      const spot = hit.spots[0]!;
      const replacement = renderPlain(parts.lines, spot, capturedOld, capturedNew, hit.tier);
      const next = [...parts.lines];
      next.splice(spot, capturedOld.length, ...replacement);
      tree.changed.set(capturedPath, joinFileText(next, parts.br, parts.ends));
    });
    prevPath = usePath;
    prevEnd = repIdx;
    i = repIdx + 1;
  }
  if (edits.length === 0) throw new ParseFault('error: parse 1');
  return edits;
}

// ---- V4A ----
interface VChunk { anchor: string | null; body: BodyLine[]; eof: boolean; }
interface VSection { kind: 'add' | 'del' | 'upd'; path: string; headIdx: number; moveTo: string | null; addLines: string[]; chunks: VChunk[]; }
function parseV4a(lines: string[]): EditFn[] {
  const firstIdx = lines.findIndex((l) => !isBlankText(l));
  if (firstIdx < 0) throw new ParseFault('error: parse 1');
  if (lines[firstIdx]!.trim() !== '*** Begin Patch') throw new ParseFault(`error: parse ${firstIdx + 1}`);
  let lastIdx = -1;
  for (let k = lines.length - 1; k >= 0; k--) { if (!isBlankText(lines[k]!)) { lastIdx = k; break; } }
  if (lastIdx < 0 || lines[lastIdx]!.trim() !== '*** End Patch') throw new ParseFault(`error: parse ${lines.length + 1}`);
  const sections: VSection[] = [];
  let idx = firstIdx + 1;
  while (idx < lastIdx) {
    const line = lines[idx]!;
    if (isBlankText(line)) { idx++; continue; }
    let kind: VSection['kind'] | null = null;
    let pth = '';
    if (line.startsWith('*** Add File: ')) { kind = 'add'; pth = line.slice('*** Add File: '.length).trim(); }
    else if (line.startsWith('*** Delete File: ')) { kind = 'del'; pth = line.slice('*** Delete File: '.length).trim(); }
    else if (line.startsWith('*** Update File: ')) { kind = 'upd'; pth = line.slice('*** Update File: '.length).trim(); }
    else throw new ParseFault(`error: parse ${idx + 1}`);
    const headIdx = idx;
    idx++;
    const rawStart = idx;
    while (idx < lastIdx) {
      const l = lines[idx]!;
      if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) break;
      idx++;
    }
    const rawEnd = idx;
    let contentEnd = rawEnd;
    while (contentEnd > rawStart && isBlankText(lines[contentEnd - 1]!)) contentEnd--;
    const vs: VSection = { kind, path: pth, headIdx, moveTo: null, addLines: [], chunks: [] };
    if (kind === 'add') {
      for (let k = rawStart; k < contentEnd; k++) {
        const l = lines[k]!;
        if (l.startsWith('+')) vs.addLines.push(l.slice(1));
        else if (l === '') vs.addLines.push('');
        else throw new ParseFault(`error: parse ${k + 1}`);
      }
    } else if (kind === 'del') {
      if (contentEnd > rawStart) throw new ParseFault(`error: parse ${rawStart + 1}`);
    } else {
      let pos = rawStart;
      if (pos < contentEnd && lines[pos]!.startsWith('*** Move to: ')) {
        vs.moveTo = lines[pos]!.slice('*** Move to: '.length).trim();
        pos++;
      }
      let cur: VChunk | null = null;
      for (let k = pos; k < contentEnd; k++) {
        const l = lines[k]!;
        if (l.trimEnd() === '*** End of File') {
          if (cur === null) { cur = { anchor: null, body: [], eof: true }; vs.chunks.push(cur); }
          else cur.eof = true;
          cur = null;
          continue;
        }
        if (l.startsWith('@@')) {
          const anchorText = l.slice(2).trim();
          cur = { anchor: anchorText === '' ? null : anchorText, body: [], eof: false };
          vs.chunks.push(cur);
          continue;
        }
        const ch = l === '' ? ' ' : l[0]!;
        if (l === '' || ch === ' ' || ch === '-' || ch === '+') {
          if (cur === null) { cur = { anchor: null, body: [], eof: false }; vs.chunks.push(cur); }
          if (l === '') cur.body.push({ kind: 'ctx', text: '', slash: false, blankRaw: true });
          else if (ch === ' ') cur.body.push({ kind: 'ctx', text: l.slice(1), slash: false, blankRaw: false });
          else if (ch === '-') cur.body.push({ kind: 'old', text: l.slice(1), slash: false, blankRaw: false });
          else cur.body.push({ kind: 'new', text: l.slice(1), slash: false, blankRaw: false });
          continue;
        }
        throw new ParseFault(`error: parse ${k + 1}`);
      }
      if (vs.chunks.length === 0 && vs.moveTo === null) throw new ParseFault(`error: parse ${headIdx + 1}`);
    }
    sections.push(vs);
  }
  if (sections.length === 0) throw new ParseFault('error: parse 1');
  return sections.map((vs) => vSectionToEdit(vs));
}
function vSectionToEdit(vs: VSection): EditFn {
  return (tree, strict) => {
    demandSafe(vs.path);
    if (vs.moveTo !== null) demandSafe(vs.moveTo);
    if (vs.kind === 'add') {
      if (tree.current(vs.path) !== null) throw new EditFault('exists', vs.path);
      const content = vs.addLines.length === 0 ? '' : vs.addLines.join('\n') + '\n';
      tree.changed.set(vs.path, content);
      return;
    }
    if (vs.kind === 'del') {
      if (tree.current(vs.path) === null) throw new EditFault('missing', vs.path);
      tree.changed.set(vs.path, null);
      return;
    }
    const existing = tree.current(vs.path);
    if (existing === null) throw new EditFault('missing', vs.path);
    if (vs.moveTo !== null && tree.current(vs.moveTo) !== null) throw new EditFault('exists', vs.moveTo);
    const parts = splitFileText(existing);
    let curLines = [...parts.lines];
    let cursor = 0;
    for (const chunk of vs.chunks) {
      if (chunk.anchor !== null) {
        const ahit = locateSingle(curLines, chunk.anchor, strict, cursor);
        if (ahit === null) throw new EditFault('no-match', vs.path);
        cursor = ahit.spots[0]! + 1;
      }
      const oldLines = bodyOldLines(chunk.body);
      const entries = bodyNewEntries(chunk.body);
      if (oldLines.length === 0) {
        const insertTexts = entries.map((e) => e.text);
        const atPos = chunk.eof ? curLines.length : Math.min(cursor, curLines.length);
        curLines.splice(atPos, 0, ...insertTexts);
        cursor = atPos + insertTexts.length;
        continue;
      }
      let hit = locateOld(curLines, oldLines, strict, cursor);
      if (hit !== null && chunk.eof) {
        const filtered = hit.spots.filter((s) => s + oldLines.length === curLines.length);
        if (filtered.length === 0) hit = null;
        else hit = { tier: hit.tier, spots: filtered };
      }
      if (hit === null) {
        if (chunk.eof) {
          // try other tiers specifically for an end-anchored occurrence
          let recovered: TierHit | null = null;
          const topTier = strict ? 0 : 2;
          for (let tier = 0; tier <= topTier && recovered === null; tier++) {
            const spots: number[] = [];
            for (let at = cursor; at + oldLines.length <= curLines.length; at++) {
              if (at + oldLines.length === curLines.length && sliceMatches(curLines, at, oldLines, tier)) spots.push(at);
            }
            if (spots.length > 0) recovered = { tier, spots };
          }
          if (recovered === null) throw new EditFault('no-match', vs.path);
          hit = recovered;
        } else {
          throw new EditFault('no-match', vs.path);
        }
      }
      const spot = hit.spots[0]!;
      const replacement = renderReplacement(curLines, spot, oldLines, entries, hit.tier);
      curLines.splice(spot, oldLines.length, ...replacement);
      cursor = spot + replacement.length;
    }
    const output = joinFileText(curLines, parts.br, parts.ends);
    if (vs.moveTo !== null) {
      tree.changed.set(vs.path, null);
      tree.changed.set(vs.moveTo, output);
      tree.moves.push([vs.path, vs.moveTo]);
    } else {
      tree.changed.set(vs.path, output);
    }
  };
}

// ---- format detection ----
function detectFormat(lines: string[]): string | null {
  const firstIdx = lines.findIndex((l) => !isBlankText(l));
  if (firstIdx < 0) return null;
  if (lines[firstIdx]!.trim() === '*** Begin Patch') return 'v4a';
  const lead = lines[firstIdx]!.trimStart()[0];
  if (lead === '[' || lead === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, k) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[k + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---- main run ----
function execute(argv: string[]): { code: number; out: string[] } {
  let fmt: string | null = null;
  let checkOnly = false;
  let strictMode = false;
  const positional: string[] = [];
  let optionsDone = false;
  for (const arg of argv) {
    if (!optionsDone && arg === '--') { optionsDone = true; continue; }
    if (!optionsDone && arg.startsWith('-') && arg !== '-') {
      if (arg.startsWith('--format=') && fmt === null && FORMAT_NAMES.includes(arg.slice(9))) fmt = arg.slice(9);
      else if (arg === '--check' && !checkOnly) checkOnly = true;
      else if (arg === '--strict' && !strictMode) strictMode = true;
      else return { code: 2, out: ['error: usage'] };
      continue;
    }
    positional.push(arg);
  }
  if (positional.length > 1) return { code: 2, out: ['error: usage'] };
  const patchName = positional.length === 0 || positional[0] === '-' ? null : positional[0]!;
  let patchText = '';
  try {
    patchText = readFileSync(patchName ?? 0, 'utf8');
  } catch {
    if (patchName !== null) return { code: 2, out: ['error: no-patch'] };
    patchText = '';
  }
  const pLines = splitPatchText(patchText);
  const chosen = fmt === null || fmt === 'auto' ? detectFormat(pLines) : fmt;
  if (chosen === null) return { code: 2, out: ['error: format'] };
  let edits: EditFn[];
  try {
    if (chosen === 'json') edits = parseJsonEdits(patchText, pLines);
    else if (chosen === 'unified') edits = parseUnified(pLines);
    else if (chosen === 'search-replace') edits = parseSearchReplace(pLines);
    else edits = parseV4a(pLines);
    if (edits.length === 0) throw new ParseFault('error: parse 1');
  } catch (e) {
    if (e instanceof ParseFault) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new VirtualTree();
  const failures: EditFault[] = [];
  for (const edit of edits) {
    const snapshot = new Map(tree.changed);
    const moveCount = tree.moves.length;
    try {
      edit(tree, strictMode);
    } catch (e) {
      if (!(e instanceof EditFault)) throw e;
      tree.changed.clear();
      for (const [k, v] of snapshot) tree.changed.set(k, v);
      tree.moves.length = moveCount;
      failures.push(e);
    }
  }
  if (failures.length > 0) {
    return { code: 1, out: [...failures.map((f) => `error: ${f.code} ${f.path}`), `failed: ${failures.length} of ${edits.length} edits`] };
  }
  // Build result rows, folding successful moves into R lines.
  const qualifies = new Map<string, string>();
  for (const [oldP, newP] of tree.moves) {
    if (tree.before(oldP) !== null && tree.current(oldP) === null && tree.before(newP) === null && tree.current(newP) !== null) {
      qualifies.set(newP, oldP);
    }
  }
  const movedOlds = new Set(qualifies.values());
  interface Row { sortKey: string; text: string; }
  const rows: Row[] = [];
  for (const p of tree.changed.keys()) {
    const was = tree.before(p);
    const now = tree.current(p);
    if (was === now) continue;
    if (movedOlds.has(p)) continue;
    if (qualifies.has(p)) { rows.push({ sortKey: p, text: `R ${qualifies.get(p)!} -> ${p}` }); continue; }
    rows.push({ sortKey: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.sortKey), Buffer.from(b.sortKey)));
  if (!checkOnly) {
    for (const p of tree.changed.keys()) {
      const was = tree.before(p);
      const now = tree.current(p);
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, now); }
    }
  }
  const outLines = rows.map((r) => r.text);
  outLines.push(`ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`);
  return { code: 0, out: outLines };
}

const envUrl = process.env.MAKEFUN_ENV_URL;
if (envUrl !== undefined && envUrl !== '') {
  const { runTrial } = await import('./runner.ts');
  await runTrial(envUrl);
} else {
  const result = execute(process.argv.slice(2));
  writeSync(1, result.out.map((l) => `${l}\n`).join(''));
  process.exitCode = result.code;
}
