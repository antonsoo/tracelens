import { ScalarType } from '@bufbuild/protobuf';
import type { DescField, DescMessage } from '@bufbuild/protobuf';
import { BinaryReader, WireType } from '@bufbuild/protobuf/wire';

export const MAX_PROTOBUF_DEPTH = 64;
export const MAX_PROTOBUF_FIELDS = 1_000_000;
export interface ProtobufBudget { fields: number }
class WireReader extends BinaryReader {
  constructor(readonly data: Uint8Array) { super(data); }
}

const fields = new WeakMap<DescMessage, ReadonlyMap<number, DescField>>();

function fieldMap(schema: DescMessage): ReadonlyMap<number, DescField> {
  let result = fields.get(schema);
  if (!result) { result = new Map(schema.fields.map(field => [field.number, field])); fields.set(schema, result); }
  return result;
}

function scalarWire(scalar: ScalarType): WireType {
  switch (scalar) {
    case ScalarType.DOUBLE: case ScalarType.FIXED64: case ScalarType.SFIXED64: return WireType.Bit64;
    case ScalarType.FLOAT: case ScalarType.FIXED32: case ScalarType.SFIXED32: return WireType.Bit32;
    case ScalarType.STRING: case ScalarType.BYTES: return WireType.LengthDelimited;
    default: return WireType.Varint;
  }
}

/** Length varints are uint32, not a truncating uint64 cast. */
function delimited(reader: WireReader): Uint8Array {
  const start = reader.pos;
  const size = reader.uint32();
  const width = reader.pos - start;
  if (width > 5 || (width === 5 && reader.data[reader.pos - 1]! > 0x0f)) throw new Error('length prefix exceeds uint32');
  const end = reader.pos + size;
  if (end > reader.len) throw new Error('field extends beyond its enclosing message');
  const bytes = reader.data.subarray(reader.pos, end);
  reader.pos = end;
  return bytes;
}

function scalar(reader: WireReader, wire: WireType): void {
  if (wire === WireType.Varint) {
    for (let i = 0; i < 10; i++) {
      if (reader.pos >= reader.len) throw new Error('varint extends beyond its enclosing message');
      if ((reader.data[reader.pos++]! & 0x80) === 0) return;
    }
    throw new Error('varint exceeds ten bytes');
  }
  reader.skip(wire);
}

/** Verify boundaries using a separate reader for each declared message extent.
 * The semantic runtime otherwise shares one reader across nested messages and
 * can consume a complete field past the end of an undersized child message.
 * Values are still interpreted only by the generated Protobuf runtime.
 */
export function assertProtobufWire(schema: DescMessage, bytes: Uint8Array, budget: ProtobufBudget): void {
  function walk(reader: WireReader, descriptor: DescMessage | undefined, depth: number, group?: number): void {
    if (depth > MAX_PROTOBUF_DEPTH) throw new Error(`protobuf nesting exceeds ${MAX_PROTOBUF_DEPTH} message/group levels`);
    const known = descriptor ? fieldMap(descriptor) : undefined;
    while (reader.pos < reader.len) {
      if (++budget.fields > MAX_PROTOBUF_FIELDS) throw new Error(`protobuf input exceeds ${MAX_PROTOBUF_FIELDS} wire fields`);
      const [number, wire] = reader.tag();
      if (wire === WireType.EndGroup) {
        if (group === number) return;
        throw new Error('unexpected or mismatched end-group tag');
      }
      const field = known?.get(number);
      const child = field?.fieldKind === 'message' || (field?.fieldKind === 'list' && field.listKind === 'message') ? field.message : undefined;
      const primitive = field?.fieldKind === 'scalar' || (field?.fieldKind === 'list' && field.listKind === 'scalar') ? scalarWire(field.scalar)
        : field?.fieldKind === 'enum' || (field?.fieldKind === 'list' && field.listKind === 'enum') ? WireType.Varint : undefined;
      const packed = field?.fieldKind === 'list' && primitive !== undefined && primitive !== WireType.LengthDelimited && wire === WireType.LengthDelimited;
      if (field?.fieldKind === 'map') throw new Error('map fields are not supported by the bundled OTLP schema');
      if (field && wire !== (child ? WireType.LengthDelimited : primitive) && !packed) {
        throw new Error(`incorrect wire type for ${descriptor!.typeName}.${field.name}`);
      }
      if (wire === WireType.LengthDelimited) {
        const data = delimited(reader);
        if (child) walk(new WireReader(data), child, depth + 1);
        else if (packed) {
          const values = new WireReader(data);
          while (values.pos < values.len) scalar(values, primitive);
        }
      } else if (wire === WireType.StartGroup) {
        walk(reader, undefined, depth + 1, number);
      } else scalar(reader, wire);
    }
    if (group !== undefined) throw new Error('unterminated group');
  }
  walk(new WireReader(bytes), schema, 1);
}
