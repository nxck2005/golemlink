import zlib from 'node:zlib'

const EOCD_SIG = 0x06054b50
const CENTRAL_SIG = 0x02014b50
const LOCAL_SIG = 0x04034b50

// Lists the entries of a zip held in memory. Enough for Minecraft client
// jars: stored or deflated entries, no zip64, no encryption.
export function listZip (buffer) {
  const min = Math.max(0, buffer.length - 22 - 0xffff)
  let eocd = -1
  for (let i = buffer.length - 22; i >= min; i--) {
    if (buffer.readUInt32LE(i) === EOCD_SIG) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('not a zip file (no end of central directory)')
  const count = buffer.readUInt16LE(eocd + 10)
  let offset = buffer.readUInt32LE(eocd + 16)
  const entries = []
  for (let i = 0; i < count; i++) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== CENTRAL_SIG) throw new Error('corrupt zip central directory')
    const flags = buffer.readUInt16LE(offset + 8)
    const method = buffer.readUInt16LE(offset + 10)
    const compressedSize = buffer.readUInt32LE(offset + 20)
    const size = buffer.readUInt32LE(offset + 24)
    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    const localOffset = buffer.readUInt32LE(offset + 42)
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength)
    entries.push({ name, method, flags, compressedSize, size, localOffset })
    offset += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

export function readZipEntry (buffer, entry) {
  const at = entry.localOffset
  if (buffer.readUInt32LE(at) !== LOCAL_SIG) throw new Error(`corrupt zip entry ${entry.name}`)
  if (entry.flags & 1) throw new Error(`encrypted zip entry ${entry.name}`)
  const start = at + 30 + buffer.readUInt16LE(at + 26) + buffer.readUInt16LE(at + 28)
  const data = buffer.subarray(start, start + entry.compressedSize)
  if (entry.method === 0) return Buffer.from(data)
  if (entry.method === 8) return zlib.inflateRawSync(data, { maxOutputLength: Math.max(entry.size, 1) })
  throw new Error(`unsupported zip compression ${entry.method} in ${entry.name}`)
}
