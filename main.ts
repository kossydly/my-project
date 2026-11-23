// mend: SPEC.md implementation (Node 22, standard library only)

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 { readonly line: string; constructor(line: string) { this.line = line; } }
class Fail { readonly code: string; readonly path: string; constructor(code: string, path: string) { this.code = code; this.path = path; } }

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function stripPrefix(p: string | null): string | null {
  if (p === null) return null;
  if (p.startsWith('a/')) return p.slice(2);
  if (p.startsWith('b/')) return p.slice(2);
  return p;
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try { if (statSync(p).isFile()) v = readFileSync(p, 'utf8'); } catch { v = null; }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null { return this.now.has(p) ? this.now.get(p)! : this.original(p); }
}

// ---------- Section 5: line matching ----------

function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+|[ \t]+$/g, '');
}

function findMatch(fileLines: string[], O: string[], start: number, tier: number): number | null {
  if (O.length === 0) return null;
  const nO = O.map((l) => normLine(l, tier));
  for (let i = start; i + O.length <= fileLines.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) { if (normLine(fileLines[i + j], tier) !== nO[j]) { ok = false; break; } }
    if (ok) return i;
  }
  return null;
}

function allMatchesAtTier(fileLines: string[], O: string[], tier: number): number[] {
  const out: number[] = [];
  if (O.length === 0) return out;
  const nO = O.map((l) => normLine(l, tier));
  for (let i = 0; i + O.length <= fileLines.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) { if (normLine(fileLines[i + j], tier) !== nO[j]) { ok = false; break; } }
    if (ok) out.push(i);
  }
  return out;
}

function findFirstTier(fileLines: string[], O: string[], start: number, strict: boolean): { tier: number; pos: number } | null {
  const maxT = strict ? 0 : 2;
  for (let t = 0; t <= maxT; t++) { const p = findMatch(fileLines, O, start, t); if (p !== null) return { tier: t, pos: p }; }
  return null;
}

// ---------- Section 9: JSON edits ----------

function jsonEdit(v: unknown): ((tree: Tree) => void) | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const pp = o.path;
  if (typeof pp !== 'string') return null;
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => { if (!safe(pp)) throw new Fail('unsafe', pp); if (tree.get(pp) !== null) throw new Fail('exists', pp); tree.now.set(pp, text); };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str; const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      if (!safe(pp)) throw new Fail('unsafe', pp);
      const before = tree.get(pp); if (before === null) throw new Fail('missing', pp);
      const crlf = before.indexOf('\r\n') >= 0;
      const t = crlf ? before.replaceAll('\r\n', '\n') : before;
      const old = oldStr.replaceAll('\r\n', '\n');
      let count = 0; for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', pp); if (count > 1) throw new Fail('ambiguous', pp);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + newStr.replaceAll('\r\n', '\n') + t.slice(at + old.length);
      tree.now.set(pp, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line; const add = patchLines(o.new_str);
    return (tree) => {
      if (!safe(pp)) throw new Fail('unsafe', pp);
      const before = tree.get(pp); if (before === null) throw new Fail('missing', pp);
      const crlf = before.indexOf('\r\n') >= 0; const br = crlf ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br); const finalBreak = before !== '' && before.endsWith(br);
      if (finalBreak) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', pp);
      lines.splice(line, 0, ...add);
      tree.now.set(pp, lines.length === 0 ? '' : lines.join(br) + (finalBreak ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string): ((tree: Tree) => void)[] {
  const edits: ((tree: Tree) => void)[] = [];
  const trimmed = text.trim();
  if (trimmed === '') throw new Exit2('error: parse 1');
  if (trimmed.startsWith('[')) {
    let v: unknown; try { v = JSON.parse(text); } catch { throw new Exit2('error: parse 1'); }
    if (!Array.isArray(v)) throw new Exit2('error: parse 1');
    for (const x of v) { const e = jsonEdit(x); if (e === null) throw new Exit2('error: parse 1'); edits.push(e); }
    return edits;
  }
  const lines = patchLines(text);
  lines.forEach((l, i) => { if (l.trim() === '') return; let e: ((tree: Tree) => void) | null = null; try { e = jsonEdit(JSON.parse(l)); } catch { e = null; } if (e === null) throw new Exit2(`error: parse ${i + 1}`); edits.push(e); });
  return edits;
}

// ---------- Section 6: Unified diff ----------

type Op = { kind: 'context' | 'remove' | 'add'; text: string };

function parseSection(lines: string[], start: number): { oldPath: string | null; newPath: string | null; isCreation: boolean; isDeletion: boolean; hunks: { ops: Op[]; a: number; noNewline: boolean }[]; next: number } | null {
  let i = start;
  let oldPath: string | null = null, newPath: string | null = null;
  let isCreation = false, isDeletion = false;

  if (lines[i].startsWith('diff --git ')) {
    const m = lines[i].match(/^diff --git a\/(.*) b\/(.*)$/);
    if (!m) throw new Exit2(`error: parse ${i + 1}`);
    oldPath = stripPrefix(m[1]); newPath = stripPrefix(m[2]); i++;
  } else if (lines[i].startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) {
    const op = lines[i].slice(4).split('\t')[0].trim(); const np = lines[i + 1].slice(4).split('\t')[0].trim();
    oldPath = stripPrefix(op === '/dev/null' ? null : op); newPath = stripPrefix(np === '/dev/null' ? null : np); i += 2;
  } else return null;

  while (i < lines.length && !lines[i].startsWith('@@')) {
    const l = lines[i];
    if (l.startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) {
      const op = l.slice(4).split('\t')[0].trim(); const np = lines[i + 1].slice(4).split('\t')[0].trim();
      oldPath = stripPrefix(op === '/dev/null' ? null : op); newPath = stripPrefix(np === '/dev/null' ? null : np); i += 2;
    } else if (l.startsWith('--- ')) throw new Exit2(`error: parse ${i + 1}`);
    else if (l.startsWith('rename from ')) oldPath = stripPrefix(l.slice(12).trim());
    else if (l.startsWith('rename to ')) newPath = stripPrefix(l.slice(10).trim());
    else if (l.startsWith('new file mode')) isCreation = true;
    else if (l.startsWith('deleted file mode')) isDeletion = true;
    else i++;
  }

  const hunks: { ops: Op[]; a: number; noNewline: boolean }[] = [];
  while (i < lines.length && lines[i].startsWith('@@')) {
    const hm = lines[i].match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (!hm) throw new Exit2(`error: parse ${i + 1}`);
    const a = parseInt(hm[1], 10); i++;
    const body: string[] = [];
    while (i < lines.length) {
      const l = lines[i];
      if (l.startsWith('diff --git ')) break;
      if (l.startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) break;
      if (l.startsWith('@@')) break;
      if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l.startsWith('\\') || l === '') { body.push(l); i++; } else break;
    }
    const ops: Op[] = []; let noNewline = false;
    for (const l of body) {
      if (l.startsWith('\\')) { noNewline = true; }
      else if (l.startsWith(' ')) ops.push({ kind: 'context', text: l.slice(1) });
      else if (l.startsWith('-')) ops.push({ kind: 'remove', text: l.slice(1) });
      else if (l.startsWith('+')) ops.push({ kind: 'add', text: l.slice(1) });
      else if (l === '') ops.push({ kind: 'context', text: '' });
    }
    hunks.push({ ops, a, noNewline });
  }

  return { oldPath, newPath, isCreation, isDeletion, hunks, next: i };
}

function applyHunks(working: string[], hunks: { ops: Op[]; a: number; noNewline: boolean }[], strict: boolean): string[] {
  let d = 0;
  for (const h of hunks) {
    const O = h.ops.filter((o) => o.kind !== 'add').map((o) => o.text);
    const N = h.ops.filter((o) => o.kind !== 'remove').map((o) => o.text);
    if (O.length === 0) {
      const addLines = h.ops.filter((o) => o.kind === 'add').map((o) => o.text);
      const pos = Math.min(h.a + d, working.length);
      working.splice(pos, 0, ...addLines);
      d += addLines.length;
      continue;
    }
    const tierInfo = findFirstTier(working, O, 0, strict);
    if (!tierInfo) throw new Fail('no-match', '');
    const tier = tierInfo.tier;
    const target = h.a - 1 + d;
    const allOcc = allMatchesAtTier(working, O, tier);
    let bestPos = allOcc[0]; let bestDist = Math.abs(allOcc[0] - target);
    for (const p of allOcc) { const dist = Math.abs(p - target); if (dist < bestDist || (dist === bestDist && p < bestPos)) { bestPos = p; bestDist = dist; } }
    const result: string[] = []; let oPos = 0; let ni = 0;
    for (const op of h.ops) {
      if (op.kind === 'add') { result.push(N[ni]!); ni++; }
      else if (op.kind === 'remove') { oPos++; }
      else { result.push(working[bestPos + oPos]!); oPos++; }
    }
    // tier 2 re-indent: align added lines to first context line's indent
    if (tier === 2 && result.length > 0) {
      const firstCtx = result.find((r, k) => h.ops[k]?.kind === 'context');
      if (firstCtx !== undefined) {
        const F = firstCtx.match(/^[ \t]*/)?.[0] ?? '';
        const P = O[0]?.match(/^[ \t]*/)?.[0] ?? '';
        for (let k = 0; k < result.length; k++) {
          if (h.ops[k]?.kind === 'add') {
            const l = result[k];
            if (l.startsWith(P)) result[k] = F + l.slice(P.length);
          }
        }
      }
    }
    working = [...working.slice(0, bestPos), ...result, ...working.slice(bestPos + O.length)];
    d += N.length - O.length;
  }
  return working;
}

function parseUnified(lines: string[], strict: boolean): ((tree: Tree) => void)[] {
  const edits: ((tree: Tree) => void)[] = [];
  let i = 0;
  while (i < lines.length) {
    const sec = parseSection(lines, i);
    if (!sec) { i++; continue; }
    i = sec.next;
    const { oldPath, newPath, isCreation, isDeletion, hunks } = sec;
    const targetPath = (isDeletion || newPath === null || newPath === '/dev/null') ? oldPath! : newPath!;
    if (!safe(targetPath)) throw new Fail('unsafe', targetPath);

    edits.push((tree) => {
      if (isCreation || oldPath === null || oldPath === '/dev/null') {
        const path = newPath!;
        if (tree.get(path) !== null) throw new Fail('exists', path);
        const createdLines: string[] = [];
        for (const h of hunks) for (const op of h.ops) if (op.kind === 'context' || op.kind === 'add') createdLines.push(op.text);
        const lastHunk = hunks[hunks.length - 1];
        let endsWithBreak = true;
        if (lastHunk && lastHunk.noNewline) endsWithBreak = false;
        const content = createdLines.length === 0 ? '' : createdLines.join('\n') + (endsWithBreak ? '\n' : '');
        tree.now.set(path, content);
        return;
      }
      if (isDeletion || newPath === null || newPath === '/dev/null') {
        const path = oldPath!; const before = tree.get(path); if (before === null) throw new Fail('missing', path);
        tree.now.set(path, null); return;
      }
      if (newPath !== null && newPath !== oldPath) {
        const oldP = oldPath!; const newP = newPath;
        const before = tree.get(oldP); if (before === null) throw new Fail('missing', oldP);
        if (tree.get(newP) !== null) throw new Fail('exists', newP);
        const crlf = before.indexOf('\r\n') >= 0; const br = crlf ? '\r\n' : '\n';
        const fileLines = before === '' ? [] : before.split(br); const finalBreak = before !== '' && before.endsWith(br);
        let working = [...fileLines]; if (finalBreak) working.pop();
        working = applyHunks(working, hunks, false);
        const content = working.length === 0 ? '' : working.join(br) + (finalBreak ? br : '');
        tree.now.set(oldP, null); tree.now.set(newP, content); return;
      }
      const path = oldPath!; const before = tree.get(path); if (before === null) throw new Fail('missing', path);
      const crlf = before.indexOf('\r\n') >= 0; const br = crlf ? '\r\n' : '\n';
      const fileLines = before === '' ? [] : before.split(br); const finalBreak = before !== '' && before.endsWith(br);
      let working = [...fileLines]; if (finalBreak) working.pop();
      working = applyHunks(working, hunks, strict);
      const content = working.length === 0 ? '' : working.join(br) + (finalBreak ? br : '');
      tree.now.set(path, content);
    });
  }
  return edits;
}

// ---------- Section 7: SEARCH/REPLACE ----------

function parseSearchReplace(lines: string[]): ((tree: Tree) => void)[] {
  const edits: ((tree: Tree) => void)[] = [];
  let i = 0; let currentPath: string | null = null;
  while (i < lines.length) {
    if (lines[i].trimEnd() === '<<<<<<< SEARCH') {
      let pathLine: string | null = null;
      for (let j = i - 1; j >= 0; j--) { const l = lines[j]; if (l.trim() === '') continue; const t = l.trim(); if (t.startsWith('```')) continue; pathLine = t; break; }
      if (pathLine !== null) currentPath = pathLine;
      if (currentPath === null) throw new Exit2(`error: parse ${i + 1}`);
      const path = currentPath!; i++;
      const oldLines: string[] = [];
      while (i < lines.length && lines[i].trimEnd() !== '=======') { oldLines.push(lines[i]); i++; }
      if (i >= lines.length) throw new Exit2(`error: parse ${i}`);
      i++;
      const newLines: string[] = [];
      while (i < lines.length && lines[i].trimEnd() !== '>>>>>>> REPLACE') { newLines.push(lines[i]); i++; }
      if (i >= lines.length) throw new Exit2(`error: parse ${i - oldLines.length - 1}`);
      i++;
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (oldLines.length === 0) { if (tree.get(path) !== null) throw new Fail('exists', path); tree.now.set(path, newLines.join('\n') + '\n'); return; }
        const before = tree.get(path); if (before === null) throw new Fail('missing', path);
        const crlf = before.indexOf('\r\n') >= 0; const br = crlf ? '\r\n' : '\n';
        const fileLines = before === '' ? [] : before.split(br); const finalBreak = before !== '' && before.endsWith(br);
        let working = [...fileLines]; if (finalBreak) working.pop();
        let foundPos: number | null = null;
        for (let t = 0; t <= 2; t++) { const occ = allMatchesAtTier(working, oldLines, t); if (occ.length === 1) { foundPos = occ[0]; break; } if (occ.length > 1 && t === 0) throw new Fail('ambiguous', path); }
        if (foundPos === null) throw new Fail('no-match', path);
        const result = [...working.slice(0, foundPos), ...newLines, ...working.slice(foundPos + oldLines.length)];
        tree.now.set(path, result.length === 0 ? '' : result.join(br) + (finalBreak ? br : ''));
      });
    } else i++;
  }
  return edits;
}

// ---------- Section 8: V4A ----------

function parseV4A(lines: string[]): ((tree: Tree) => void)[] {
  const edits: ((tree: Tree) => void)[] = [];
  const first = lines.findIndex((l) => l.trim() !== '');
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  const last = lines.findLastIndex((l) => l.trim() !== '');
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  let i = first + 1;
  while (i < last) {
    if (lines[i].trim() === '') { i++; continue; }
    const l = lines[i];
    if (l.startsWith('*** Add File: ')) {
      const path = l.slice(14).trim(); i++;
      const body: string[] = [];
      while (i < last && !lines[i].startsWith('*** Add File: ') && !lines[i].startsWith('*** Delete File: ') && !lines[i].startsWith('*** Update File: ') && !lines[i].startsWith('*** End Patch')) { body.push(lines[i]); i++; }
      edits.push((tree) => { if (!safe(path)) throw new Fail('unsafe', path); if (tree.get(path) !== null) throw new Fail('exists', path); tree.now.set(path, body.join('\n') + '\n'); });
    } else if (l.startsWith('*** Delete File: ')) {
      const path = l.slice(17).trim(); i++;
      edits.push((tree) => { if (!safe(path)) throw new Fail('unsafe', path); if (tree.get(path) === null) throw new Fail('missing', path); tree.now.set(path, null); });
    } else if (l.startsWith('*** Update File: ')) {
      const path = l.slice(17).trim(); i++;
      let moveTo: string | null = null;
      if (i < last && lines[i].startsWith('*** Move to: ')) { moveTo = lines[i].slice(13).trim(); i++; }
      const chunks: { anchor: string | null; ops: Op[]; endOfFile: boolean }[] = [];
      while (i < last && !lines[i].startsWith('*** Add File: ') && !lines[i].startsWith('*** Delete File: ') && !lines[i].startsWith('*** Update File: ') && !lines[i].startsWith('*** End Patch') && !lines[i].startsWith('*** End of File')) {
        if (lines[i].startsWith('@@')) { const anchor = lines[i].slice(2).trim(); i++; const body: string[] = []; while (i < last && !lines[i].startsWith('@@') && !lines[i].startsWith('*** End of File') && !lines[i].startsWith('*** Add File: ') && !lines[i].startsWith('*** Delete File: ') && !lines[i].startsWith('*** Update File: ') && !lines[i].startsWith('*** End Patch')) { body.push(lines[i]); i++; } const endOfFile = i < last && lines[i] === '*** End of File'; if (endOfFile) i++; const { ops } = parseV4aBody(body); chunks.push({ anchor: anchor || null, ops, endOfFile }); }
        else { const body: string[] = []; while (i < last && !lines[i].startsWith('@@') && !lines[i].startsWith('*** End of File') && !lines[i].startsWith('*** Add File: ') && !lines[i].startsWith('*** Delete File: ') && !lines[i].startsWith('*** Update File: ') && !lines[i].startsWith('*** End Patch')) { body.push(lines[i]); i++; } const endOfFile = i < last && lines[i] === '*** End of File'; if (endOfFile) i++; const { ops } = parseV4aBody(body); chunks.push({ anchor: null, ops, endOfFile }); }
      }
      if (chunks.length === 0 && !moveTo) throw new Exit2(`error: parse ${i}`);
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path); if (moveTo && !safe(moveTo)) throw new Fail('unsafe', moveTo);
        const before = tree.get(path); if (before === null) throw new Fail('missing', path);
        const crlf = before.indexOf('\r\n') >= 0; const br = crlf ? '\r\n' : '\n';
        const fileLines = before === '' ? [] : before.split(br); const finalBreak = before !== '' && before.endsWith(br);
        let working = [...fileLines]; if (finalBreak) working.pop();
        let cursor = 0;
        for (const chunk of chunks) {
          if (chunk.anchor !== null) { let foundPos: number | null = null; for (let t = 0; t <= 2; t++) { for (let p = cursor; p < working.length; p++) { if (normLine(working[p], t) === normLine(chunk.anchor, t)) { foundPos = p; break; } } if (foundPos !== null) break; } if (foundPos === null) throw new Fail('no-match', path); cursor = foundPos + 1; }
          const O = chunk.ops.filter((o) => o.kind !== 'add').map((o) => o.text);
          if (O.length === 0) { const addLines = chunk.ops.filter((o) => o.kind === 'add').map((o) => o.text); const pos = chunk.endOfFile ? working.length : Math.min(cursor, working.length); working.splice(pos, 0, ...addLines); cursor = pos + addLines.length; continue; }
          let foundPos: number | null = null; for (let t = 0; t <= 2; t++) { for (let p = cursor; p + O.length <= working.length; p++) { let ok = true; for (let j = 0; j < O.length; j++) { if (normLine(working[p + j], t) !== normLine(O[j], t)) { ok = false; break; } } if (ok) { foundPos = p; break; } } if (foundPos !== null) break; } if (foundPos === null) throw new Fail('no-match', path);
          if (chunk.endOfFile && foundPos + O.length !== working.length) throw new Fail('no-match', path);
          const result: string[] = []; let oPos = 0; for (const op of chunk.ops) { if (op.kind === 'add') result.push(op.text); else { result.push(working[foundPos + oPos]!); oPos++; } }
          working = [...working.slice(0, foundPos), ...result, ...working.slice(foundPos + O.length)]; cursor = foundPos + result.length;
        }
        const content = working.length === 0 ? '' : working.join(br) + (finalBreak ? br : '');
        if (moveTo) { tree.now.set(path, null); tree.now.set(moveTo, content); } else tree.now.set(path, content);
      });
    } else throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

function parseV4aBody(body: string[]): { ops: Op[] } {
  const ops: Op[] = [];
  for (const l of body) { if (l.startsWith(' ')) ops.push({ kind: 'context', text: l.slice(1) }); else if (l.startsWith('-')) ops.push({ kind: 'remove', text: l.slice(1) }); else if (l.startsWith('+')) ops.push({ kind: 'add', text: l.slice(1) }); else if (l === '') ops.push({ kind: 'context', text: '' }); }
  return { ops };
}

// ---------- Detect format ----------

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => l.trim() !== '');
  if (first < 0) return null;
  const t = lines[first]!.trim();
  if (t === '*** Begin Patch') return 'v4a';
  const c = t[0]; if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, idx) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[idx + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---------- Main run ----------

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null; let check = false; let strict = false; const pos: string[] = []; let ended = false;
  for (const a of args) {
    if (!ended && a === '--') { ended = true; continue; }
    if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null) { const v = a.slice(9); if (!FORMATS.includes(v)) return { code: 2, out: ['error: format'] }; format = v; }
      else if (a === '--check' && !check) { check = true; }
      else if (a === '--strict' && !strict) { strict = true; }
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = ''; try { if (file !== null) text = readFileSync(file, 'utf8'); } catch { if (file !== null) return { code: 2, out: ['error: no-patch'] }; }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: ((tree: Tree) => void)[];
  try { if (kind === 'json') edits = jsonEdits(text); else if (kind === 'unified') edits = parseUnified(lines, strict); else if (kind === 'search-replace') edits = parseSearchReplace(lines); else if (kind === 'v4a') edits = parseV4A(lines); else throw new Exit2('error: parse 1'); if (edits.length === 0) throw new Exit2('error: parse 1'); }
  catch (e) { if (e instanceof Exit2) return { code: 2, out: [e.line] }; throw e; }
  const tree = new Tree(); const fails: Fail[] = [];
  for (const edit of edits) { const before = new Map(tree.now); try { edit(tree); } catch (e) { if (!(e instanceof Fail)) throw e; tree.now.clear(); for (const [k, v] of before) tree.now.set(k, v); fails.push(e); } }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: string[] = [];
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) { const was = tree.original(p); const now = tree.now.get(p)!; if (was === now) continue; if (was === null) rows.push(`A ${p}`); else if (now === null) rows.push(`D ${p}`); else rows.push(`M ${p}`); if (check) continue; if (now === null) rmSync(p, { force: true }); else { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, now); } }
  const changed = rows.length;
  return { code: 0, out: [...rows, `ok: ${changed} ${changed === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  try {
    const r = run(process.argv.slice(2));
    writeSync(1, r.out.map((l) => `${l}\n`).join(''));
    process.exitCode = r.code;
  } catch (e) {
    writeSync(1, `error: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 1;
  }
}
