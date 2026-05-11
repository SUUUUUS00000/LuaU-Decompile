// bytecode_reader.h
#pragma once
#include <cstdint>
#include <vector>
#include <string>

class BytecodeReader {
public:
    struct FunctionProto {
        uint8_t maxStackSize;
        uint8_t numParams;
        uint8_t numUpvals;
        uint8_t isVararg;
        uint8_t flags;
        std::vector<uint32_t> instructions;
        std::vector<double> kNumber;
        std::vector<int64_t> kInteger;
        std::vector<std::string> kString;
        std::vector<uint32_t> protoIds;
    };

    bool load(const std::vector<uint8_t>& bytecode);
    bool load(const std::string& filepath);
    const FunctionProto* getFunction(uint32_t id) const;
    uint32_t getMainFunctionId() const { return mainFuncId; }
    uint8_t getVersion() const { return version; }
    uint8_t getFlags() const { return flags; }

private:
    std::vector<uint8_t> data;
    std::vector<FunctionProto> functions;
    uint32_t mainFuncId = 0;
    uint8_t version = 0;
    uint8_t flags = 0;
    size_t offset = 0;

    bool parseBytecode();
    template<typename T> T read();
    std::string readString();
};

template<typename T> T BytecodeReader::read() {
    T val = *reinterpret_cast<const T*>(&data[offset]);
    offset += sizeof(T);
    return val;
}
