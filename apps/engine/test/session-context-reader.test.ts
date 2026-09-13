import { describe, expect, it } from 'vitest';
import { ContextReadBudgets, readContextPage } from '../src/session-context-reader.js';
import type { SessionContextRecord } from '@linmu/dsh-session-contracts';

const ref: SessionContextRecord = { schemaVersion:1,referenceId:'ref-a',sourceSessionId:'source',sourceVersionId:'v1',
  cutoffEventId:'end',cutoffDigest:'digest',targetSessionId:'target',selectedText:'选区',sourceTitle:'来源',sourceAnchorId:'reply',
  state:'sent',targetMessageId:'user',createdAt:'2026-09-13T00:00:00Z' };

describe('bounded fixed upstream pages', () => {
  it('reassembles every character of a long Chinese/emoji/tool-output message without growing a return', () => {
    const text = '中文😀\\\"\n'.repeat(2500);
    const entries = [{eventId:'end',role:'assistant',text}];
    let cursor: string | undefined, restored = '', calls = 0;
    do {
      const page = readContextPage(ref, entries, 2048, cursor);
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(2048);
      expect(page.items.length).toBeGreaterThan(0);
      restored += page.items.map(item=>item.text).join('');
      cursor = page.nextCursor ?? undefined;
      expect(++calls).toBeLessThan(1000);
    } while (cursor);
    expect(restored).toBe(text);
    expect(calls).toBeGreaterThan(20);
  });
  it('finds later matches in one long message and returns an original-text read cursor', () => {
    const text = 'first NEEDLE ' + '填充'.repeat(4000) + ' second needle end';
    const entries = [{eventId:'end',role:'assistant',text}];
    const page = readContextPage(ref, entries, 4000, undefined, 'needle');
    expect(page.items).toHaveLength(2);
    const result = readContextPage(ref, entries, 3000, page.items[1]!.readCursor);
    expect(result.items[0]!.text).toContain('second needle end');
    expect(() => readContextPage({...ref,sourceVersionId:'v2'},entries,3000,page.items[1]!.readCursor)).toThrow('游标');
    expect(() => readContextPage(ref,entries,3000,page.items[1]!.readCursor,'needle')).toThrow('游标');
  });
  it('skips empty transcript entries without hiding older material or returning a stuck cursor', () => {
    const entries = [
      {eventId:'empty-oldest',role:'user',text:''},
      {eventId:'older',role:'user',text:'Earlier context'},
      {eventId:'reasoning-only',role:'assistant',text:''},
      {eventId:'newer',role:'assistant',text:'Selected reply'},
      {eventId:'empty-latest',role:'tool',text:''},
    ];
    const page = readContextPage(ref, entries, 3000);
    expect(page.items.map(item=>[item.eventId,item.text])).toEqual([
      ['newer','Selected reply'],['older','Earlier context'],
    ]);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
    expect(readContextPage(ref,[entries[0]!],3000)).toMatchObject({items:[],hasMore:false,nextCursor:null});
  });
  it('advances an accepted cursor at the end of a message to older material', () => {
    const entries = [{eventId:'older',role:'user',text:'Earlier context'},
      {eventId:'end',role:'assistant',text:'Long selected reply '.repeat(500)}];
    const first = readContextPage(ref, entries, 2048);
    expect(first.nextCursor).not.toBeNull();
    const cursor = JSON.parse(Buffer.from(first.nextCursor!,'base64url').toString('utf8')) as [string,number,number];
    cursor[2] = entries[1]!.text.length;
    const page = readContextPage(ref,entries,2048,Buffer.from(JSON.stringify(cursor)).toString('base64url'));
    expect(page.items.map(item=>item.text)).toEqual(['Earlier context']);
    expect(page).toMatchObject({hasMore:false,nextCursor:null});
  });
  it('does not reset a turn allowance for retries, parallel pages or a larger requested limit', () => {
    const budgets = new ContextReadBudgets();
    const a = budgets.reserve('target/turn', 12000, 8000);
    const b = budgets.reserve('target/turn', 64000, 8000);
    expect([a.bytes,b.bytes]).toEqual([8000,4000]);
    expect(budgets.reserve('target/turn',64000,8000).bytes).toBe(0);
    a.settle(6000); b.settle(4000);
    const retry=budgets.reserve('target/turn',64000,8000);
    expect(retry.bytes).toBe(2000); retry.settle(2000);
    expect(budgets.reserve('target/turn',64000,8000).bytes).toBe(0);
    expect(budgets.reserve('target/next-turn',12000,8000).bytes).toBe(8000);
  });
});
