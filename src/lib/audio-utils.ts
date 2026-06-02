import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { once } from "node:events";
import type { OutputFormat } from "./types";

interface ParsedWav {
  audioFormat: number;
  channels: number;
  sampleRate: number;
  byteRate: number;
  blockAlign: number;
  bitsPerSample: number;
  data: Buffer;
}

interface ParsedWavFile extends Omit<ParsedWav, "data"> {
  filePath: string;
  dataStart: number;
  dataSize: number;
}

async function readExact(file: FileHandle, length: number, position: number) {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await file.read(buffer, 0, length, position);
  if (bytesRead !== length) throw new Error("Invalid WAV audio.");
  return buffer;
}

async function parsePcmWavFile(filePath: string): Promise<ParsedWavFile> {
  const file = await fs.open(filePath, "r");

  try {
    const header = await readExact(file, 12, 0);
    if (header.toString("ascii", 0, 4) !== "RIFF" || header.toString("ascii", 8, 12) !== "WAVE") {
      throw new Error("Only WAV audio can be merged into a final local file.");
    }

    const { size } = await file.stat();
    let offset = 12;
    let fmt: Omit<ParsedWav, "data"> | undefined;
    let dataStart: number | undefined;
    let dataSize: number | undefined;

    while (offset + 8 <= size) {
      const chunkHeader = await readExact(file, 8, offset);
      const id = chunkHeader.toString("ascii", 0, 4);
      const chunkSize = chunkHeader.readUInt32LE(4);
      const chunkDataStart = offset + 8;
      const chunkDataEnd = chunkDataStart + chunkSize;
      if (chunkDataEnd > size) throw new Error("Invalid WAV audio.");

      if (id === "fmt ") {
        if (chunkSize < 16) throw new Error("Invalid WAV fmt chunk.");
        const value = await readExact(file, 16, chunkDataStart);
        fmt = {
          audioFormat: value.readUInt16LE(0),
          channels: value.readUInt16LE(2),
          sampleRate: value.readUInt32LE(4),
          byteRate: value.readUInt32LE(8),
          blockAlign: value.readUInt16LE(12),
          bitsPerSample: value.readUInt16LE(14)
        };
      }

      if (id === "data") {
        dataStart = chunkDataStart;
        dataSize = chunkSize;
        break;
      }

      offset = chunkDataEnd + (chunkSize % 2);
    }

    if (!fmt || dataStart === undefined || dataSize === undefined) throw new Error("Invalid WAV audio.");
    if (fmt.audioFormat !== 1) throw new Error("Only PCM WAV audio can be merged.");

    return { ...fmt, filePath, dataStart, dataSize };
  } finally {
    await file.close();
  }
}

function createPcmWavHeader(wav: Omit<ParsedWav, "data">, dataSize: number) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(wav.audioFormat, 20);
  header.writeUInt16LE(wav.channels, 22);
  header.writeUInt32LE(wav.sampleRate, 24);
  header.writeUInt32LE(wav.byteRate, 28);
  header.writeUInt16LE(wav.blockAlign, 32);
  header.writeUInt16LE(wav.bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);
  return header;
}

async function writePart(output: ReturnType<typeof createWriteStream>, data: Buffer) {
  if (!output.write(data)) {
    await once(output, "drain");
  }
}

export async function detectAudioFileFormat(filePath: string): Promise<OutputFormat> {
  const file = await fs.open(filePath, "r");

  try {
    const header = Buffer.alloc(12);
    const { bytesRead } = await file.read(header, 0, header.length, 0);
    if (bytesRead >= 12 && header.toString("ascii", 0, 4) === "RIFF" && header.toString("ascii", 8, 12) === "WAVE") {
      return "wav";
    }

    const hasId3Header = bytesRead >= 3 && header.toString("ascii", 0, 3) === "ID3";
    const hasMpegFrameSync = bytesRead >= 2 && header[0] === 0xff && (header[1] & 0xe0) === 0xe0;
    if (hasId3Header || hasMpegFrameSync) {
      return "mp3";
    }
  } finally {
    await file.close();
  }

  throw new Error("Remote provider returned an unsupported audio format.");
}

async function mergeMp3Files(filePaths: string[], outputFilePath: string) {
  const output = createWriteStream(outputFilePath);
  try {
    for (const filePath of filePaths) {
      const input = createReadStream(filePath);
      for await (const chunk of input) {
        await writePart(output, chunk as Buffer);
      }
    }
    output.end();
    await once(output, "finish");
  } catch (error) {
    output.destroy();
    await fs.rm(outputFilePath, { force: true });
    throw error;
  }
}

export async function mergeAudioFiles(filePaths: string[], outputFilePath: string, format: OutputFormat, gapMilliseconds = 180) {
  if (filePaths.length === 0) throw new Error("No audio chunks to merge.");

  const formats = await Promise.all(filePaths.map(detectAudioFileFormat));
  if (formats.some((value) => value !== format)) {
    throw new Error("Generated audio chunks have different formats and cannot be merged safely.");
  }

  if (format === "mp3") {
    await mergeMp3Files(filePaths, outputFilePath);
    return;
  }

  await mergeWavFiles(filePaths, outputFilePath, gapMilliseconds);
}

export async function mergeWavFiles(filePaths: string[], outputFilePath: string, gapMilliseconds = 180) {
  if (filePaths.length === 0) throw new Error("No WAV audio chunks to merge.");
  if (filePaths.length === 1) {
    await fs.copyFile(filePaths[0], outputFilePath);
    return;
  }

  const parsed: ParsedWavFile[] = [];
  for (const filePath of filePaths) {
    parsed.push(await parsePcmWavFile(filePath));
  }

  const first = parsed[0];
  for (const wav of parsed.slice(1)) {
    const compatible =
      wav.audioFormat === first.audioFormat &&
      wav.channels === first.channels &&
      wav.sampleRate === first.sampleRate &&
      wav.blockAlign === first.blockAlign &&
      wav.bitsPerSample === first.bitsPerSample;

    if (!compatible) {
      throw new Error("Generated WAV chunks have different audio formats and cannot be merged safely.");
    }
  }

  const silenceBytes = Math.floor((first.byteRate * gapMilliseconds) / 1000 / first.blockAlign) * first.blockAlign;
  const dataSize = parsed.reduce((total, wav) => total + wav.dataSize, 0) + silenceBytes * (parsed.length - 1);
  if (dataSize > 0xffffffff - 36) throw new Error("Merged WAV file is too large.");

  const output = createWriteStream(outputFilePath);
  try {
    await writePart(output, createPcmWavHeader(first, dataSize));
    const silence = Buffer.alloc(silenceBytes);

    for (const [index, wav] of parsed.entries()) {
      const input = createReadStream(wav.filePath, {
        start: wav.dataStart,
        end: wav.dataStart + wav.dataSize - 1
      });
      for await (const chunk of input) {
        await writePart(output, chunk as Buffer);
      }
      if (index < parsed.length - 1) {
        await writePart(output, silence);
      }
    }

    output.end();
    await once(output, "finish");
  } catch (error) {
    output.destroy();
    await fs.rm(outputFilePath, { force: true });
    throw error;
  }
}
