import { describe, expect, it } from 'vitest';
import { noteSelectionSchema, sessionStickerSchema } from '../src/session-knowledge.js';

describe('bounded selected-note session stickers',()=>{
  const selected={selectedText:'selected excerpt',selectedTextHash:'sha256:'+'a'.repeat(64),occurrence:1};
  const note={vaultId:'vault',noteId:'stable-note',notePath:'folder/note.md',blockId:'stable-block'};
  it('keeps a selected excerpt with its stable source and rejects detached or unbounded text',()=>{
    expect(sessionStickerSchema.parse({kind:'session',logicalSessionId:'target',note,noteSelection:selected})).toMatchObject({note,noteSelection:selected});
    expect(sessionStickerSchema.safeParse({kind:'session',logicalSessionId:'target',noteSelection:selected}).success).toBe(false);
    expect(noteSelectionSchema.safeParse({...selected,selectedText:'x'.repeat(16001)}).success).toBe(false);
    expect(noteSelectionSchema.safeParse({...selected,selectedTextHash:'unverified'}).success).toBe(false);
    expect(noteSelectionSchema.safeParse({...selected,occurrence:-1}).success).toBe(false);
    expect(sessionStickerSchema.safeParse({kind:'session',logicalSessionId:'target',note,snapshot:'whole note'}).success).toBe(false);
  });
});
