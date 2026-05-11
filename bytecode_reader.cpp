// bytecode_reader.cpp
#include "bytecode_reader.h"
#include <fstream>
#include <cstring>

bool BytecodeReader::load(const std::vector<uint8_t>& bytecode) {
    data = bytecode;
    offset = 0;
    lastError.clear();
    return parseBytecode();
}

bool BytecodeReader::load(const std::string& filepath) {
    std::ifstream file(filepath, std::ios::binary | std::ios::ate);
    if (!file) {
        lastError = "Cannot open file";
        return false;
    }
    auto size = file.tellg();
    file.seekg(0, std::ios::beg);
    data.resize(size);
    file.read(reinterpret_cast<char*>(data.data()), size);
    offset = 0;
    lastError.clear();
    return parseBytecode();
}

bool BytecodeReader::parseBytecode() {
    if (data.size() < 5) {
        lastError = "Bytecode too small (size " + std::to_string(data.size()) + ")";
        return false;
    }
    const char LUAU_SIGNATURE[] = "\0Lua\x81";
    bool hasSignature = (memcmp(data.data(), LUAU_SIGNATURE, 5) == 0);

    if (hasSignature) {
        offset = 5;
        version = read<uint8_t>();
        flags = read<uint8_t>();
        mainFuncId = read<uint32_t>();
        uint32_t numFunctions = read<uint32_t>();
        if (numFunctions == 0) {
            lastError = "No functions in bytecode";
            return false;
        }
        functions.resize(numFunctions);
        for (uint32_t i = 0; i < numFunctions; ++i) {
            FunctionProto func;
            if (!readFunctionProto(func, i, false)) return false;
            functions[i] = std::move(func);
        }
    } else {
        version = 0;
        flags = 0;
        mainFuncId = 0;
        offset = 0;
        if (parseWireFormat()) {
            return true;
        }
        offset = 0;
        lastError.clear();
        functions.clear();
        functions.resize(1);
        if (!readFunctionProto(functions[0], 0, false)) {
            lastError = "Failed to parse as raw function dump: " + lastError;
            return false;
        }
    }
    return true;
}

bool BytecodeReader::parseWireFormat() {
    offset = 0;
    functions.clear();
    uint32_t numFunctions = readVarInt();
    if (numFunctions == 0 || numFunctions > 100000) {
        lastError = "Invalid wire format: numFunctions=" + std::to_string(numFunctions);
        return false;
    }
    functions.resize(numFunctions);
    for (uint32_t i = 0; i < numFunctions; ++i) {
        FunctionProto func;
        if (!readFunctionProto(func, i, true)) return false;
        functions[i] = std::move(func);
    }
    return true;
}

bool BytecodeReader::readFunctionProto(FunctionProto& func, uint32_t index, bool isWire) {
    if (offset + 5 > data.size()) {
        lastError = "Function " + std::to_string(index) + ": unexpected end of bytecode in header at offset " + std::to_string(offset);
        return false;
    }
    func.maxStackSize = read<uint8_t>();
    func.numParams = read<uint8_t>();
    func.numUpvals = read<uint8_t>();
    func.isVararg = read<uint8_t>();
    func.flags = read<uint8_t>();

    if (isWire) {
        uint32_t numStrings = readVarInt();
        func.kString.resize(numStrings);
        for (uint32_t j = 0; j < numStrings; ++j) {
            func.kString[j] = readString(true);
            if (!lastError.empty()) return false;
        }

        uint32_t numNumbers = readVarInt();
        if (offset + numNumbers * sizeof(double) > data.size()) {
            lastError = "Function " + std::to_string(index) + ": unexpected end of bytecode in numbers at offset " + std::to_string(offset);
            return false;
        }
        func.kNumber.resize(numNumbers);
        for (uint32_t j = 0; j < numNumbers; ++j)
            func.kNumber[j] = read<double>();

        uint32_t numInts = readVarInt();
        if (offset + numInts * sizeof(int64_t) > data.size()) {
            lastError = "Function " + std::to_string(index) + ": unexpected end of bytecode in integers at offset " + std::to_string(offset);
            return false;
        }
        func.kInteger.resize(numInts);
        for (uint32_t j = 0; j < numInts; ++j)
            func.kInteger[j] = read<int64_t>();

        uint32_t numInstr = readVarInt();
        if (numInstr > 500000) {
            lastError = "Function " + std::to_string(index) + ": too many instructions (" + std::to_string(numInstr) + ") at offset " + std::to_string(offset);
            return false;
        }
        if (offset + numInstr * sizeof(uint32_t) > data.size()) {
            lastError = "Function " + std::to_string(index) + ": unexpected end of bytecode in instructions at offset " + std::to_string(offset);
            return false;
        }
        func.instructions.resize(numInstr);
        for (uint32_t j = 0; j < numInstr; ++j)
            func.instructions[j] = read<uint32_t>();

        uint32_t numProtos = readVarInt();
        if (offset + numProtos * sizeof(uint32_t) > data.size()) {
            lastError = "Function " + std::to_string(index) + ": unexpected end in protos at offset " + std::to_string(offset);
            return false;
        }
        func.protoIds.resize(numProtos);
        for (uint32_t j = 0; j < numProtos; ++j)
            func.protoIds[j] = read<uint32_t>();

        uint32_t lineCount = readVarInt();
        if (offset + lineCount * sizeof(int32_t) > data.size()) {
            lastError = "Function " + std::to_string(index) + ": unexpected end in line info at offset " + std::to_string(offset);
            return false;
        }
        offset += lineCount * sizeof(int32_t);
    } else {
        uint32_t numInstr = read<uint32_t>();
        if (numInstr > 500000) {
            lastError = "Function " + std::to_string(index) + ": too many instructions (" + std::to_string(numInstr) + ") at offset " + std::to_string(offset);
            return false;
        }
        if (offset + numInstr * sizeof(uint32_t) > data.size()) {
            lastError = "Function " + std::to_string(index) + ": unexpected end of bytecode in instructions at offset " + std::to_string(offset);
            return false;
        }
        func.instructions.resize(numInstr);
        for (uint32_t j = 0; j < numInstr; ++j)
            func.instructions[j] = read<uint32_t>();

        uint32_t numNumbers = read<uint32_t>();
        if (offset + numNumbers * sizeof(double) > data.size()) {
            lastError = "Function " + std::to_string(index) + ": unexpected end of bytecode in numbers at offset " + std::to_string(offset);
            return false;
        }
        func.kNumber.resize(numNumbers);
        for (uint32_t j = 0; j < numNumbers; ++j)
            func.kNumber[j] = read<double>();

        uint32_t numInts = read<uint32_t>();
        if (offset + numInts * sizeof(int64_t) > data.size()) {
            lastError = "Function " + std::to_string(index) + ": unexpected end of bytecode in integers at offset " + std::to_string(offset);
            return false;
        }
        func.kInteger.resize(numInts);
        for (uint32_t j = 0; j < numInts; ++j)
            func.kInteger[j] = read<int64_t>();

        uint32_t numStrings = read<uint32_t>();
        func.kString.resize(numStrings);
        for (uint32_t j = 0; j < numStrings; ++j) {
            func.kString[j] = readString(false);
            if (!lastError.empty()) return false;
        }

        uint32_t numProtos = read<uint32_t>();
        if (offset + numProtos * sizeof(uint32_t) > data.size()) {
            lastError = "Function " + std::to_string(index) + ": unexpected end in protos at offset " + std::to_string(offset);
            return false;
        }
        func.protoIds.resize(numProtos);
        for (uint32_t j = 0; j < numProtos; ++j)
            func.protoIds[j] = read<uint32_t>();

        uint32_t lineCount = read<uint32_t>();
        if (offset + lineCount * sizeof(int32_t) > data.size()) {
            lastError = "Function " + std::to_string(index) + ": unexpected end in line info at offset " + std::to_string(offset);
            return false;
        }
        offset += lineCount * sizeof(int32_t);
    }
    return true;
}

std::string BytecodeReader::readString(bool isWire) {
    uint32_t len = isWire ? readVarInt() : read<uint32_t>();
    if (offset + len > data.size()) {
        lastError = "Unexpected end in string data at offset " + std::to_string(offset);
        return {};
    }
    std::string s(reinterpret_cast<const char*>(&data[offset]), len);
    offset += len;
    return s;
}

uint32_t BytecodeReader::readVarInt() {
    uint32_t result = 0;
    unsigned shift = 0;
    while (true) {
        if (offset >= data.size()) {
            lastError = "Unexpected end in varint at offset " + std::to_string(offset);
            return 0;
        }
        uint8_t byte = data[offset++];
        result |= (byte & 0x7F) << shift;
        if ((byte & 0x80) == 0) break;
        shift += 7;
        if (shift > 28) {
            lastError = "Varint too long at offset " + std::to_string(offset);
            return 0;
        }
    }
    return result;
}

uint32_t BytecodeReader::readCount(bool isWire) {
    return isWire ? readVarInt() : read<uint32_t>();
}

const BytecodeReader::FunctionProto* BytecodeReader::getFunction(uint32_t id) const {
    if (id < functions.size()) return &functions[id];
    return nullptr;
}
