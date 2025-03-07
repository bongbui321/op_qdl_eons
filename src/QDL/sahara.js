import { CommandHandler, cmd_t, sahara_mode_t, status_t, exec_cmd_t } from "./saharaDefs"
import { containsBytes, concatUint8Array, packGenerator, loadFileFromLocal, readBlobAsBuffer } from "./utils";
import config from "@/config"

export class Sahara {
  cdc;
  ch; // CommandHandler
  pktSize;
  version;
  programmer;
  id;
  mode;

  constructor(cdc) {
    this.cdc        = cdc;
    this.pktSize    = null;
    this.version    = null;
    this.ch         = new CommandHandler();
    // TODO: change to auto upload Loader
    //this.programmer = "0008e0e100000000_afca69d4235117e5_fhprg.bin";
    this.programmer = "6000000000010000_f8ab20526358c4fa_fhprg.bin"
    this.id         = null;
    this.serial     = "";
    this.mode       = "";
  }

  async connect() {
    try {
      let v = await this.cdc?.read(0xC * 0x4);
      if (v.length > 1){
        if (v[0] == 0x01){
          let pkt = this.ch.pkt_cmd_hdr(v);
          if (pkt.cmd === cmd_t.SAHARA_HELLO_REQ) {
            let rsp      = this.ch.pkt_hello_req(v);
            this.pktSize = rsp.cmd_packet_length;
            this.version = rsp.version;
            return { "mode" : "sahara", "cmd" : cmd_t.SAHARA_HELLO_REQ, "data" : rsp };
          }
        }
      }
    } catch (error) {
      console.error(error);
    }
    return { "mode" : "error" };
  } 


  async cmdHello(mode, version=2, version_min=1, max_cmd_len=0) {
    let cmd            = cmd_t.SAHARA_HELLO_RSP;
    let len            = 0x30;
    const elements     = [cmd, len, version, version_min, max_cmd_len, mode, 1, 2, 3, 4, 5, 6];
    const responseData = packGenerator(elements);

    try {
      await this.cdc?.write(responseData);
      return true;
    } catch (error) {
      console.error(error);
      return false;
    }
  }


  async cmdModeSwitch(mode){
    const elements = [cmd_t.SAHARA_SWITCH_MODE, 0xC, mode];
    let data       = packGenerator(elements);

    try {
      await this.cdc?.write(data);
      return true;
    } catch (error) {
      console.error(error);
      return false;
    }
  }


  async getResponse() {
    try {
      let data      = await this.cdc?.read();
      let data_text = new TextDecoder('utf-8').decode(data.data);
      if (data.length == 0){
        return {};
      } else if (data_text.includes("<?xml")){
        return {"firehose" : "yes"};
      }
      let pkt = this.ch.pkt_cmd_hdr(data);
      if (pkt.cmd === cmd_t.SAHARA_HELLO_REQ) {
        return { "cmd" : pkt.cmd, "data" : this.ch.pkt_hello_req(data) };
      } else if (pkt.cmd === cmd_t.SAHARA_DONE_RSP) {
        return {"cmd": pkt.cmd, "data":this.ch.pkt_done(data)}
      } else if (pkt.cmd === cmd_t.SAHARA_END_TRANSFER){
        return {"cmd": pkt.cmd, "data": this.ch.pkt_image_end(data)};
      } else if (pkt.cmd === cmd_t.SAHARA_64BIT_MEMORY_READ_DATA) {
        return {"cmd": pkt.cmd, "data": this.ch.pkt_read_data_64(data)}
      } else if (pkt.cmd === cmd_t.SAHARA_EXECUTE_RSP) {
        return {"cmd": pkt.cmd, "data": this.ch.pkt_execute_rsp_cmd(data)};
      } else if (pkt.cmd === cmd_t.SAHARA_CMD_READY || pkt.cmd == cmd_t.SAHARA_RESET_RSP) {
        return {"cmd": pkt.cmd, "data": null };
      } else {
        console.error("Didn't match any cmd_t")
      }
      return {};
    } catch (error) {
      console.error(error);
      return {};
    }
  }


  async cmdExec(mcmd) {
    let dataToSend = packGenerator([cmd_t.SAHARA_EXECUTE_REQ, 0xC, mcmd]);
    await this.cdc.write(dataToSend);
    let res = await this.getResponse();
    if (res.hasOwnProperty("cmd")) {
      let cmd = res["cmd"];
      if (cmd == cmd_t.SAHARA_EXECUTE_RSP) {
        let pkt = res["data"];
        let data = packGenerator([cmd_t.SAHARA_EXECUTE_DATA, 0xC, mcmd]);
        await this.cdc.write(data);
        let payload = await this.cdc.read(pkt.data_len);
        return payload;
      } else if (cmd == cmd_t.SAHARA_END_TRANSFER) {
        let pkt = res["data"];
        console.error("error while executing command");
      }
      return null;
    }
    return res;
  }


  async cmdGetSerialNum() {
    let res = await this.cmdExec(exec_cmd_t.SAHARA_EXEC_CMD_SERIAL_NUM_READ);
    let data = new DataView(res.buffer, 0).getUint32(0, true);
    return data.toString(16).padStart(8, '0');
  }


  async enterCommandMode(version=2) {
    if (!await this.cmdHello(sahara_mode_t.SAHARA_MODE_COMMAND)){
      return false;
    }
    let res = await this.getResponse();
    if (res.hasOwnProperty("cmd")){
      if (res["cmd"] === cmd_t.SAHARA_END_TRANSFER){
        if (res.hasOwnProperty("data")){
          return false;
        }
      } else if (res["cmd"] === cmd_t.SAHARA_CMD_READY){
        return true;
      }
    }
    return false;
  }


  async downLoadLoader() {
    let writable;
    try {
      const fileHandle = await root.getFileHandle(this.programmer, { create: true });
      writable = await fileHandle.createWritable();
    } catch (e) {
      throw `Error opening file handle: ${e}`;
    }

    const programmerUrl = config.loader['url'];
    const response = await fetch(programmerUrl, { mode: 'cors' })
    if (!response.ok) {
      throw `Fetch failed: ${response.status} ${response.statusText}`
    }

    try {
      let processed = 0;
      //const contentLength = +response.headers.get('Content-Length');
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done)
          break;
        await writable.write(value);
        processed += value.length;
      }
    } catch (e) {
      throw `Could not read response body: ${e}`
    }

    try {
      await writable.close()
    } catch (e) {
      throw `Error closing file handle: ${e}`
    }
  }


  async uploadLoader(version){
    if (!(await this.enterCommandMode(version))) {
      console.error("Failed to enter command mode in Sahara");
      return "error"
    } else {
      try {
        this.serial = await this.cmdGetSerialNum();
        await this.cmdModeSwitch(sahara_mode_t.SAHARA_MODE_COMMAND);
      } catch (error) {
        console.error(error);
        return;
      }
    }

    let connectResp = await this.connect();
    if ((connectResp["mode"] != "sahara")) {
      return "";
    }

    console.log("Uploading Programmer...");
    // TODO: change to auto download
    //let programmer = new Uint8Array(await readBlobAsBuffer(await downloadLoader()));
    let programmer = new Uint8Array(await readBlobAsBuffer(await loadFileFromLocal()));
    if (!(await this.cmdHello(sahara_mode_t.SAHARA_MODE_IMAGE_TX_PENDING, version=version))) {
      return "error";
    }

    try {
      let datalen = programmer.length;
      let done    = false;
      let loop    = 0;
      while (datalen >= 0 || done){
        let resp = await this.getResponse();
        let cmd
        if (resp.hasOwnProperty("cmd")){
          cmd = resp["cmd"];
        } else {
          console.error("Timeout while uploading loader. Wrong loader?");
          return "error"
        }
        if (cmd == cmd_t.SAHARA_DONE_REQ){
          if (self.cmdDone()){
            return "error"
          }
        }
        if ([cmd_t.SAHARA_64BIT_MEMORY_READ_DATA,cmd_t.SAHARA_READ_DATA].includes(cmd)) {
          if (cmd == cmd_t.SAHARA_64BIT_MEMORY_READ_DATA)
            if (loop == 0)
              console.log("64-bit mode detected");
          let pkt = resp["data"];
          this.id = pkt.image_id;
          if (this.id >= 0xC){
            this.mode = "firehose";
            if (loop == 0)
              console.log("Firehose mode detected, uploading...");
          } else {
            console.error("Unknown sahara id");
            return "error";
          }

          loop += 1;
          let dataOffset = pkt.data_offset;
          let dataLen    = pkt.data_len;
          if (dataOffset + dataLen > programmer.length) {
            const fillerArray = new Uint8Array(dataOffset+dataLen-programmer.length).fill(0xff);
            programmer = concatUint8Array([programmer, fillerArray]);
          }
          let dataToSend = programmer.slice(dataOffset, dataOffset+dataLen); // Uint8Array
          await this.cdc?.write(dataToSend);
          datalen -= dataLen;

        } else if (cmd == cmd_t.SAHARA_END_TRANSFER) {
          let pkt = resp["data"];
          if (pkt.image_tx_status == status_t.SAHARA_STATUS_SUCCESS){
            if (await this.cmdDone()){
              console.log("Loader successfully uploaded");
            } else {
              console.error("Error on uploading loader.");
            }
            return this.mode;
          }
        }
      }
    } catch (error) {
      console.error(error);
      return "error";
    }
    return this.mode;
  }


  async cmdDone(){
    const toSendData = packGenerator([cmd_t.SAHARA_DONE_REQ, 0x8]);
    if (await this.cdc.write(toSendData)) {
      let res = await this.getResponse();
      for (let i = 0; i < 500; i += 1)
        continue;
      if (res.hasOwnProperty("cmd")){
        let cmd = res["cmd"];
        if (cmd == cmd_t.SAHARA_DONE_RSP){
          return true
        } else if (cmd == cmd_t.SAHARA_END_TRANSFER){
          if (res.hasOwnProperty("data")) {
            let pkt = res["data"];
            if (pkt.iamge_txt_status == status_t.SAHARA_NAK_INVALID_CMD){
              console.error("Invalid transfer command received");
              return false;
            }
          }
        } else {
          console.error("received invalid resposne");
        }
      }
    }
    return false;
  }
}
