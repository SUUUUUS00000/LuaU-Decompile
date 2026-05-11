// bytecode_reader.cpp
#include "bytecode_reader.h"
#include <fstream>
#include <stdexcept>
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
    if (data.size() < 5 + 1 + 1 + 4 + 4) {
        lastError = "Bytecode too small (size " + std::to_string(data.size()) + ")";
        return false;
    }
    const char LUAU_SIGNATURE[] = "\0Lua\x81";
    if (memcmp(data.data(), LUAU_SIGNATURE, 5) != 0) {
        lastError = "Invalid signature at offset 0";
        return false;
    }
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
        func.maxStackSize = read<uint8_t>();
        func.numParams = read<uint8_t>();
        func.numUpvals = read<uint8_t>();
        func.isVararg = read<uint8_t>();
        func.flags = read<uint8_t>();
        uint32_t numInstr = read<uint32_t>();
        if (offset + numInstr * sizeof(uint32_t) > data.size()) {
            lastError = "Function " + std::to_string(i) + ": unexpected end of bytecode in instructions at offset " + std::to_string(offset);
            return false;
        }
        func.instructions.resize(numInstr);
        for (uint32_t j = 0; j < numInstr; ++j)
            func.instructions[j] = read<uint32_t>();
        uint32_t numNumbers = read<uint32_t>();
        if (offset + numNumbers * sizeof(double) > data.size()) {
            lastError = "Function " + std::to_string(i) + ": unexpected end of bytecode in numbers at offset " + std::to_string(offset);
            return false;
        }
        func.kNumber.resize(numNumbers);
        for (uint32_t j = 0; j < numNumbers; ++j)
            func.kNumber[j] = read<double>();
        uint32_t numInts = read<uint32_t>();
        if (offset + numInts * sizeof(int64_t) > data.size()) {
            lastError = "Function " + std::to_string(i) + ": unexpected end of bytecode in integers at offset " + std::to_string(offset);
            return false;
        }
        func.kInteger.resize(numInts);
        for (uint32_t j = 0; j < numInts; ++j)
            func.kInteger[j] = read<int64_t>();
        uint32_t numStrings = read<uint32_t>();
        func.kString.resize(numStrings);
        for (uint32_t j = 0; j < numStrings; ++j) {
            if (offset + sizeof(uint32_t) > data.size()) {
                lastError = "Function " + std::to_string(i) + ": unexpected end of bytecode in string length at offset " + std::to_string(offset);
                return false;
            }
            func.kString[j] = readString();
        }
        uint32_t numProtos = read<uint32_t>();
        if (offset + numProtos * sizeof(uint32_t) > data.size()) {
            lastError = "Function " + std::to_string(i) + ": unexpected end of bytecode in protos at offset " + std::to_string(offset);
            return false;
        }
        func.protoIds.resize(numProtos);
        for (uint32_t j = 0; j < numProtos; ++j)
            func.protoIds[j] = read<uint32_t>();

        uint32_t lineCount = read<uint32_t>();
        if (offset + lineCount * sizeof(int32_t) > data.size()) {
            lastError = "Function " + std::to_string(i) + ": unexpected end of bytecode in line info at offset " + std::to_string(offset);
            return false;
        }
        offset += lineCount * sizeof(int32_t);

        functions[i] = std::move(func);
    }
    return true;
}

std::string BytecodeReader::readString() {
    uint32_t len = read<uint32_t>();
    if (offset + len > data.size()) {
        lastError = "Unexpected end of bytecode in string data at offset " + std::to_string(offset);
        return {};
    }
    std::string s(reinterpret_cast<const char*>(&data[offset]), len);
    offset += len;
    return s;
}

const BytecodeReader::FunctionProto* BytecodeReader::getFunction(uint32_t id) const {
    if (id < functions.size()) return &functions[id];
    return nullptr;
}
