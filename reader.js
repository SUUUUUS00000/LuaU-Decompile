class bufferreader {
    constructor(buffer) {
        this.buffer = buffer;
        this.offset = 0;
    }

    readbyte() {
        let val = this.buffer.readUInt8(this.offset);
        this.offset += 1;
        return val;
    }

    readint32() {
        let val = this.buffer.readInt32LE(this.offset);
        this.offset += 4;
        return val;
    }

    readstring(len) {
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
            result |= (byte & 127) << shift;
            shift += 7;
        } while (byte & 128);
        return result;
    }
}

module.exports = bufferreader;
