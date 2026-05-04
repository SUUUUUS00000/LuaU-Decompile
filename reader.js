class bufferreader {
    constructor(buffer) {
        this.buffer = buffer;
        this.offset = 0;
        this.length = buffer.length;
    }
    readbyte() {
        if (this.offset >= this.length) return 0;
        let val = this.buffer.readUInt8(this.offset);
        this.offset += 1;
        return val;
    }
    readuint32() {
        if (this.offset + 4 > this.length) return 0;
        let val = this.buffer.readUInt32LE(this.offset);
        this.offset += 4;
        return val;
    }
    readstring(len) {
        if (this.offset + len > this.length) len = this.length - this.offset;
        let str = this.buffer.toString('utf8', this.offset, this.offset + len);
        this.offset += len;
        return str;
    }
    readvarint() {
        let result = 0;
        let shift = 0;
        let byte;
        do {
            byte = this.readbyte();
            result += (byte & 127) * Math.pow(2, shift);
            shift += 7;
            if (shift > 35) break; 
        } while (byte & 128);
        return result;
    }
}
module.exports = bufferreader;
