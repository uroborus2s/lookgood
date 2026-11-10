import { createHash, createHmac } from 'node:crypto';

/**
 * 隐式 AI 标识。字段对齐《人工智能生成合成内容标识办法》及
 * TC260 实践指南里的文件元数据：Label / ContentProducer / ProduceID / ReservedCode1 /
 * ContentPropagator / PropagateID / ReservedCode2。
 * JPEG 写入 XMP（TC260:AIGC）和 EXIF UserComment；PNG 写入 iTXt；WEBP 写入 XMP chunk。
 * 显式标识仍由小程序角标展示「AI 生成」，这里只负责文件内的隐式部分。
 * ReservedCode 在配置了 AIGC_RESERVED_SECRET 时为 HMAC-SHA256，否则为 SHA-256 摘要。
 * 这不是监管平台证书签名，上线前如平台要求正式签名需替换。
 */
export type AigcFields = {
  Label: '1';
  ContentProducer: string;
  ProduceID: string;
  ReservedCode1: string;
  ContentPropagator: string;
  PropagateID: string;
  ReservedCode2: string;
};

export function buildAigcFields(o: { producer: string; propagator: string; produceId: string; secret: string; propagateId?: string }): AigcFields {
  const propagateId = o.propagateId || o.produceId;
  const producer = o.producer || '一身好看';
  const propagator = o.propagator || producer;
  return {
    Label: '1',
    ContentProducer: producer,
    ProduceID: o.produceId,
    ReservedCode1: signReserved(o.secret, `1|${producer}|${o.produceId}`),
    ContentPropagator: propagator,
    PropagateID: propagateId,
    ReservedCode2: signReserved(o.secret, `1|${propagator}|${propagateId}`),
  };
}

function signReserved(secret: string, content: string) {
  if (secret) return createHmac('sha256', secret).update(content).digest('hex');
  return createHash('sha256').update(content).digest('hex');
}

/** 仅用于 mock：真实 JPEG 容器，便于嵌入元数据。不是可浏览的照片。 */
export const MINIMAL_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

export function embedAigcMetadata(input: Buffer, meta: AigcFields): Buffer {
  const json = JSON.stringify(meta);
  if (isJpeg(input)) return embedJpeg(input, json);
  if (isPng(input)) return embedPng(input, json);
  if (isWebp(input)) return embedWebp(input, json);
  throw new Error('仅支持在 JPEG、PNG、WEBP 中写入 AI 隐式标识');
}

export function readAigcMetadata(input: Buffer): AigcFields | null {
  const json = readAigcJson(input);
  if (!json) return null;
  try {
    const o = JSON.parse(json);
    if (o?.Label == null || !o.ProduceID || !o.ContentProducer) return null;
    return o as AigcFields;
  } catch { return null; }
}

export function sniffImage(buf: Buffer): 'jpeg' | 'png' | 'webp' {
  if (isJpeg(buf)) return 'jpeg';
  if (isPng(buf)) return 'png';
  if (isWebp(buf)) return 'webp';
  throw new Error('无法识别的图片格式');
}

const isJpeg = (b: Buffer) => b.length >= 2 && b[0] === 0xff && b[1] === 0xd8;
const isPng = (b: Buffer) => b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
const isWebp = (b: Buffer) => b.length >= 12 && b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP';

function escapeXml(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function unescapeXml(s: string) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function xmpPacket(json: string) {
  const xml = `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about="" xmlns:TC260="http://www.tc260.org.cn/ns/AIGC/1.0/">
   <TC260:AIGC>${escapeXml(json)}</TC260:AIGC>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
  return Buffer.concat([Buffer.from('http://ns.adobe.com/xap/1.0/\0'), Buffer.from(xml, 'utf8')]);
}

function exifApp1(json: string) {
  const comment = Buffer.concat([Buffer.from('ASCII\0\0\0'), Buffer.from(json, 'utf8')]);
  const tiff = Buffer.alloc(26 + comment.length);
  tiff.write('II', 0, 'ascii');
  tiff.writeUInt16LE(0x002a, 2);
  tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(1, 8);
  tiff.writeUInt16LE(0x9286, 10);
  tiff.writeUInt16LE(7, 12);
  tiff.writeUInt32LE(comment.length, 14);
  tiff.writeUInt32LE(26, 18);
  tiff.writeUInt32LE(0, 22);
  comment.copy(tiff, 26);
  return Buffer.concat([Buffer.from('Exif\0\0'), tiff]);
}

function jpegSegment(marker: number, payload: Buffer) {
  const seg = Buffer.alloc(4 + payload.length);
  seg[0] = 0xff;
  seg[1] = marker;
  seg.writeUInt16BE(payload.length + 2, 2);
  payload.copy(seg, 4);
  return seg;
}

function embedJpeg(jpeg: Buffer, json: string) {
  const extra = Buffer.concat([jpegSegment(0xe1, xmpPacket(json)), jpegSegment(0xe1, exifApp1(json))]);
  return Buffer.concat([jpeg.subarray(0, 2), extra, jpeg.subarray(2)]);
}

function embedPng(png: Buffer, json: string) {
  const chunk = pngChunk('iTXt', iTXt('AIGC', json));
  const iend = png.indexOf(Buffer.from('IEND'));
  if (iend < 4) throw new Error('PNG 缺少 IEND');
  const at = iend - 4;
  return Buffer.concat([png.subarray(0, at), chunk, png.subarray(at)]);
}

function embedWebp(webp: Buffer, json: string) {
  const payload = xmpPacket(json);
  const size = Buffer.alloc(4);
  size.writeUInt32LE(payload.length, 0);
  const pad = payload.length % 2 === 1 ? Buffer.from([0]) : Buffer.alloc(0);
  const chunk = Buffer.concat([Buffer.from('XMP '), size, payload, pad]);
  const out = Buffer.concat([webp, chunk]);
  out.writeUInt32LE(out.length - 8, 4);
  return out;
}

function readAigcJson(buf: Buffer): string | null {
  if (isPng(buf)) {
    for (const c of pngChunks(buf)) {
      if (c.type === 'iTXt' && c.data.subarray(0, 5).toString() === 'AIGC\0') {
        const rest = c.data.subarray(5);
        const langEnd = rest.indexOf(0, 2);
        const transEnd = rest.indexOf(0, langEnd + 1);
        return rest.subarray(transEnd + 1).toString('utf8');
      }
      if (c.type === 'tEXt' && c.data.subarray(0, 5).toString() === 'AIGC\0') return c.data.subarray(5).toString('utf8');
    }
  }
  if (isWebp(buf)) {
    const xmp = webpChunk(buf, 'XMP ');
    if (xmp) return jsonFromXmp(xmp);
  }
  if (isJpeg(buf)) {
    for (const seg of jpegApp1(buf)) {
      if (seg.subarray(0, 28).toString().startsWith('http://ns.adobe.com/xap/1.0/')) {
        const json = jsonFromXmp(seg);
        if (json) return json;
      }
      if (seg.subarray(0, 6).toString() === 'Exif\0\0') {
        const json = jsonFromExif(seg.subarray(6));
        if (json) return json;
      }
    }
  }
  return null;
}

function jsonFromXmp(seg: Buffer) {
  const xml = seg.toString('utf8');
  const m = xml.match(/<TC260:AIGC>([\s\S]*?)<\/TC260:AIGC>/);
  return m ? unescapeXml(m[1]!) : null;
}

function jsonFromExif(tiff: Buffer) {
  if (tiff.length < 26 || tiff.toString('ascii', 0, 2) !== 'II') return null;
  const count = tiff.readUInt32LE(14);
  const off = tiff.readUInt32LE(18);
  if (tiff.readUInt16LE(10) !== 0x9286 || off + 8 > tiff.length) return null;
  const body = tiff.subarray(off, off + count);
  const text = body.subarray(0, 5).toString() === 'ASCII' ? body.subarray(8) : body;
  const s = text.toString('utf8');
  return s.startsWith('{') ? s : null;
}

function jpegApp1(buf: Buffer) {
  const out: Buffer[] = [];
  let offset = 2;
  while (offset + 3 < buf.length) {
    if (buf[offset] !== 0xff) break;
    while (buf[offset] === 0xff) offset++;
    const marker = buf[offset++]!;
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x00 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    if (offset + 2 > buf.length) break;
    const len = buf.readUInt16BE(offset);
    const start = offset + 2;
    const end = offset + len;
    if (end > buf.length) break;
    if (marker === 0xe1) out.push(buf.subarray(start, end));
    offset = end;
  }
  return out;
}

export function crc32(buf: Buffer) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function pngChunk(type: string, data: Buffer) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

function iTXt(keyword: string, text: string) {
  return Buffer.concat([
    Buffer.from(keyword), Buffer.from([0]),
    Buffer.from([0, 0]),
    Buffer.from([0]),
    Buffer.from([0]),
    Buffer.from(text, 'utf8'),
  ]);
}

function pngChunks(buf: Buffer) {
  const out: { type: string; data: Buffer }[] = [];
  let offset = 8;
  while (offset + 12 <= buf.length) {
    const len = buf.readUInt32BE(offset);
    const type = buf.subarray(offset + 4, offset + 8).toString('ascii');
    const data = buf.subarray(offset + 8, offset + 8 + len);
    out.push({ type, data });
    offset += 12 + len;
    if (type === 'IEND') break;
  }
  return out;
}

function webpChunk(buf: Buffer, want: string) {
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const type = buf.subarray(offset, offset + 4).toString('ascii');
    const size = buf.readUInt32LE(offset + 4);
    const data = buf.subarray(offset + 8, offset + 8 + size);
    if (type === want) return data;
    offset += 8 + size + (size % 2);
  }
  return null;
}
