// disassembler.h
#pragma once
#include "bytecode_reader.h"
#include <string>

class Disassembler {
public:
    Disassembler(const BytecodeReader& reader);
    std::string disassemble() const;
private:
    std::string disassembleFunction(uint32_t funcId, int indent = 0) const;
    std::string formatInstruction(const BytecodeReader::FunctionProto& func, uint32_t inst) const;
    const BytecodeReader& reader;
};
