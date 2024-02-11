export class structHelper_io {
  data;
  direction;

  constructor(data) {
    this.data = data;
  }

  dword(idx_start) {
    // TODO: check endianess
    dat = new TextDecoder('utf-8').decode(data).substring(idx_start, idx_start + 4 - 1);
    return dat;
  }

  qword(idx_start) {
    dat = new TextDecoder('utf-8').decode(data).substring(idx_start, idx_start + 8 - 1);
    return dat;
  }

}


export function packGenerator(elements, littleEndian=true) {
  let n = elements.length;
  const buffer = new ArrayBuffer(n*32);
  console.log("buffer byte length:", buffer.byteLength);
  const view = new DataView(buffer);

  for (let i = 0; i < n; i++){
    view.setUint32(i, elements[i], littleEndian);
  }

  return view;
}