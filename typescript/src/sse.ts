/** Decode data frames only. A frame is complete only at its blank line. */
export async function* decodeSse(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<{
  id: string;
  event: string;
  data: string;
}> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  let id = "";
  let event = "";
  let data: string[] = [];
  try {
    while (true) {
      const chunk = await reader.read();
      buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      let end: number;
      while ((end = buffer.search(/[\r\n]/)) !== -1) {
        if (buffer[end] === "\r" && end === buffer.length - 1 && !chunk.done)
          break;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(
          end + (buffer.slice(end, end + 2) === "\r\n" ? 2 : 1),
        );
        if (line === "") {
          if (data.length) yield { id, event, data: data.join("\n") };
          event = "";
          data = [];
          continue;
        }
        const separator = line.indexOf(":");
        const field = separator === -1 ? line : line.slice(0, separator);
        const value =
          separator === -1 ? "" : line.slice(separator + 1).replace(/^ /, "");
        if (field === "data") data.push(value);
        else if (field === "event") event = value;
        else if (field === "id" && !value.includes("\0")) id = value;
      }
      if (chunk.done) return;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
