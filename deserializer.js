class LuauDeserializer {
    constructor(buffer) {
        this.buffer = buffer;
        this.cursor = 0;
    }

    readByte() {
        let val = this.buffer.readUInt8(this.cursor);
        this.cursor += 1;
        return val;
    }

    readVarInt() {
        let result = 0;
        let shift = 0;
        let byteVal;
        do {
            byteVal = this.readByte();
            result |= (byteVal & 127) << shift;
            shift += 7;
        } while (byteVal >= 128);
        return result;
    }

    readString() {
        let length = this.readVarInt();
        let str = this.buffer.toString('utf8', this.cursor, this.cursor + length);
        this.cursor += length;
        return str;
    }

    deserialize() {
        let version = this.readByte();
        if (version === 0) return null;

        let stringCount = this.readVarInt();
        let strings = [];
        for (let i = 0; i < stringCount; i++) {
            strings.push(this.readString());
        }

        let protoCount = this.readVarInt();
        let protos = [];
        for (let i = 0; i < protoCount; i++) {
            let proto = {
                id: i,
                maxStackSize: this.readByte(),
                numParams: this.readByte(),
                numUpvalues: this.readByte(),
                isVararg: this.readByte(),
                code: [],
                k: [],
                p: []
            };

            let sizeCode = this.readVarInt();
            for (let j = 0; j < sizeCode; j++) {
                proto.code.push(this.buffer.readUInt32LE(this.cursor));
                this.cursor += 4;
            }

            let sizeK = this.readVarInt();
            for (let j = 0; j < sizeK; j++) {
                let kType = this.readByte();
                if (kType === 1) {
                    proto.k.push(this.readByte() === 1);
                } else if (kType === 2) {
                    proto.k.push(this.buffer.readDoubleLE(this.cursor));
                    this.cursor += 8;
                } else if (kType === 3) {
                    proto.k.push(strings[this.readVarInt()]);
                } else if (kType === 4) {
                    this.cursor += 4;
                    proto.k.push("import");
                } else if (kType === 5) {
                    let tableSize = this.readVarInt();
                    for (let t = 0; t < tableSize; t++) {
                        this.readVarInt();
                    }
                    proto.k.push("table");
                } else if (kType === 6) {
                    proto.k.push(this.readVarInt());
                } else if (kType === 7) {
                    this.cursor += 16;
                    proto.k.push("vector");
                } else {
                    proto.k.push(null);
                }
            }

            let sizeP = this.readVarInt();
            for (let j = 0; j < sizeP; j++) {
                proto.p.push(this.readVarInt());
            }

            proto.linedefined = this.readVarInt();
            proto.debugname = this.readVarInt();

            let hasLineInfo = this.readByte();
            if (hasLineInfo === 1) {
                let linegaplog2 = this.readByte();
                let intervals = ((sizeCode - 1) >> linegaplog2) + 1;
                this.cursor += sizeCode;
                this.cursor += (intervals * 4);
            }

            let hasDebugInfo = this.readByte();
            if (hasDebugInfo === 1) {
                let debuginfoSize = this.readVarInt();
                for (let j = 0; j < debuginfoSize; j++) {
                    this.readVarInt();
                    this.readVarInt();
                    this.readVarInt();
                    this.readByte();
                }
            }

            protos.push(proto);
        }

        let mainProtoId = this.readVarInt();
        return {
            mainProto: protos[mainProtoId],
            protos: protos,
            strings: strings
        };
    }
}

module.exports = { LuauDeserializer };
