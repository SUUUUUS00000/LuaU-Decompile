// main.cpp
#include <iostream>
#include "bytecode_reader.h"
#include "disassembler.h"

int main(int argc, char* argv[]) {
    if (argc < 2) {
        std::cerr << "Usage: luau-decompiler <bytecode_file>\n";
        return 1;
    }
    BytecodeReader reader;
    if (!reader.load(argv[1])) {
        std::cerr << "Failed to load bytecode file.\n";
        return 1;
    }
    Disassembler dis(reader);
    std::cout << dis.disassemble();
    return 0;
}
