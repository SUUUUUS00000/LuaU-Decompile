// disassembler.cpp
#include "disassembler.h"
#include "luau/Bytecode.h"
#include <sstream>
#include <iomanip>

static const char* opcodeNames[] = {
    "NOP", "LOADNIL", "LOADB", "LOADN", "LOADK", "MOVE", "GETGLOBAL", "SETGLOBAL",
    "GETUPVAL", "SETUPVAL", "GETIMPORT", "GETTABLE", "SETTABLE", "GETTABLEKS", "SETTABLEKS",
    "GETTABLEN", "SETTABLEN", "NEWCLOSURE", "DUPCLOSURE", "NAMECALL", "CALL", "RETURN",
    "JUMP", "JUMPBACK", "JUMPIF", "JUMPIFNOT", "JUMPIFEQ", "JUMPIFNOTEQ", "JUMPIFLT",
    "JUMPIFNOTLT", "JUMPIFLE", "JUMPIFNOTLE", "JUMPXEQKNIL", "JUMPXEQKB", "JUMPXEQKN",
    "JUMPXEQKS", "ADD", "SUB", "MUL", "DIV", "MOD", "POW", "ADDK", "SUBK", "MULK",
    "DIVK", "MODK", "POWK", "SUBRK", "DIVRK", "AND", "OR", "ANDK", "ORK", "CONCAT",
    "NOT", "MINUS", "LENGTH", "NEWTABLE", "DUPTABLE", "SETLIST", "FORNPREP", "FORNLOOP",
    "FORGLOOP", "FORGPREP", "FORGPREP_INEXT", "FORGPREP_NEXT", "FASTCALL", "FASTCALL1",
    "FASTCALL2", "FASTCALL2K", "FASTCALL3", "COVERAGE", "CLOSEUPVALS", "CAPTURE",
    "PREPVARARGS", "GETVARARGS", "LOADKX"
};

static std::string opName(uint8_t op) {
    if (op < sizeof(opcodeNames)/sizeof(opcodeNames[0])) return opcodeNames[op];
    return "UNK" + std::to_string(op);
}

Disassembler::Disassembler(const BytecodeReader& reader) : reader(reader) {}

std::string Disassembler::disassemble() const {
    std::ostringstream out;
    out << "; Luau Bytecode Disassembly\n";
    out << "; Version: " << (int)reader.getVersion() << ", Flags: " << (int)reader.getFlags() << "\n\n";
    out << disassembleFunction(reader.getMainFunctionId(), 0);
    return out.str();
}

std::string Disassembler::disassembleFunction(uint32_t funcId, int indent) const {
    const auto* func = reader.getFunction(funcId);
    if (!func) return "";
    std::ostringstream out;
    std::string pad(indent * 2, ' ');
    out << pad << "Function #" << funcId << ":\n";
    out << pad << "  params=" << (int)func->numParams
        << ", stack=" << (int)func->maxStackSize
        << ", upvals=" << (int)func->numUpvals
        << ", vararg=" << (int)func->isVararg << "\n";
    out << pad << "  Constants:\n";
    for (size_t i = 0; i < func->kNumber.size(); ++i)
        out << pad << "    " << i << " N: " << func->kNumber[i] << "\n";
    for (size_t i = 0; i < func->kInteger.size(); ++i)
        out << pad << "    " << (i + func->kNumber.size()) << " I: " << func->kInteger[i] << "\n";
    for (size_t i = 0; i < func->kString.size(); ++i)
        out << pad << "    " << (i + func->kNumber.size() + func->kInteger.size()) << " S: \"" << func->kString[i] << "\"\n";
    out << pad << "  Instructions:\n";
    for (size_t i = 0; i < func->instructions.size(); ++i) {
        out << pad << "    " << std::setw(4) << i << ": "
            << formatInstruction(*func, func->instructions[i]) << "\n";
    }
    for (uint32_t childId : func->protoIds)
        out << disassembleFunction(childId, indent + 1);
    return out.str();
}

std::string Disassembler::formatInstruction(const BytecodeReader::FunctionProto& func, uint32_t inst) const {
    uint8_t op = inst & 0xFF;
    uint8_t A = (inst >> 8) & 0xFF;
    uint8_t C = (inst >> 16) & 0xFF;
    uint8_t B = (inst >> 24) & 0xFF;
    int16_t D = (inst >> 16) & 0xFFFF;
    std::ostringstream line;
    line << opName(op);
    switch (op) {
        case Luau::LOP_LOADNIL: line << " R" << (int)A << " " << (int)C; break;
        case Luau::LOP_LOADB: line << " R" << (int)A << " " << (int)B; break;
        case Luau::LOP_LOADN: line << " R" << (int)A << " " << D; break;
        case Luau::LOP_LOADK: line << " R" << (int)A << " K" << D; break;
        case Luau::LOP_MOVE: line << " R" << (int)A << " R" << (int)C; break;
        case Luau::LOP_GETGLOBAL: line << " R" << (int)A << " K" << D; break;
        case Luau::LOP_SETGLOBAL: line << " R" << (int)A << " K" << D; break;
        case Luau::LOP_GETUPVAL: line << " R" << (int)A << " U" << (int)C; break;
        case Luau::LOP_SETUPVAL: line << " R" << (int)A << " U" << (int)C; break;
        case Luau::LOP_GETTABLE: line << " R" << (int)A << " R" << (int)C << " R" << (int)B; break;
        case Luau::LOP_SETTABLE: line << " R" << (int)A << " R" << (int)C << " R" << (int)B; break;
        case Luau::LOP_GETTABLEKS: line << " R" << (int)A << " R" << (int)C << " K" << D; break;
        case Luau::LOP_SETTABLEKS: line << " R" << (int)A << " R" << (int)C << " K" << D; break;
        case Luau::LOP_GETTABLEN: line << " R" << (int)A << " R" << (int)C << " " << (int)B; break;
        case Luau::LOP_SETTABLEN: line << " R" << (int)A << " R" << (int)C << " " << (int)B; break;
        case Luau::LOP_NEWCLOSURE: line << " R" << (int)A << " P" << D; break;
        case Luau::LOP_DUPCLOSURE: line << " R" << (int)A << " K" << D; break;
        case Luau::LOP_NAMECALL: line << " R" << (int)A << " R" << (int)C << " K" << D; break;
        case Luau::LOP_CALL: line << " R" << (int)A << " " << (int)C << " " << (int)B; break;
        case Luau::LOP_RETURN: line << " R" << (int)A << " " << (int)C; break;
        case Luau::LOP_JUMP: line << " offset " << D; break;
        case Luau::LOP_JUMPBACK: line << " offset " << D; break;
        case Luau::LOP_JUMPIF: line << " R" << (int)A << " offset " << D; break;
        case Luau::LOP_JUMPIFNOT: line << " R" << (int)A << " offset " << D; break;
        case Luau::LOP_JUMPIFEQ: line << " R" << (int)A << " R" << (int)C << " offset " << (int)B; break;
        case Luau::LOP_JUMPIFNOTEQ: line << " R" << (int)A << " R" << (int)C << " offset " << (int)B; break;
        case Luau::LOP_JUMPIFLT: line << " R" << (int)A << " R" << (int)C << " offset " << (int)B; break;
        case Luau::LOP_JUMPIFNOTLT: line << " R" << (int)A << " R" << (int)C << " offset " << (int)B; break;
        case Luau::LOP_JUMPIFLE: line << " R" << (int)A << " R" << (int)C << " offset " << (int)B; break;
        case Luau::LOP_JUMPIFNOTLE: line << " R" << (int)A << " R" << (int)C << " offset " << (int)B; break;
        case Luau::LOP_JUMPXEQKNIL: line << " R" << (int)A << " offset " << (inst >> 16); break;
        case Luau::LOP_JUMPXEQKB: line << " R" << (int)A << " bool " << (B ? "true" : "false") << " offset " << (inst >> 16); break;
        case Luau::LOP_JUMPXEQKN: line << " R" << (int)A << " K" << D; break;
        case Luau::LOP_JUMPXEQKS: line << " R" << (int)A << " K" << D; break;
        case Luau::LOP_ADD: case Luau::LOP_SUB: case Luau::LOP_MUL: case Luau::LOP_DIV:
        case Luau::LOP_MOD: case Luau::LOP_POW: case Luau::LOP_ADDK: case Luau::LOP_SUBK:
        case Luau::LOP_MULK: case Luau::LOP_DIVK: case Luau::LOP_MODK: case Luau::LOP_POWK:
        case Luau::LOP_SUBRK: case Luau::LOP_DIVRK:
            line << " R" << (int)A << " R" << (int)C << " R" << (int)B; break;
        case Luau::LOP_AND: case Luau::LOP_OR:
            line << " R" << (int)A << " R" << (int)C << " R" << (int)B; break;
        case Luau::LOP_ANDK: case Luau::LOP_ORK:
            line << " R" << (int)A << " R" << (int)C << " K" << B; break;
        case Luau::LOP_CONCAT:
            line << " R" << (int)A << " R" << (int)C << " R" << (int)B; break;
        case Luau::LOP_NOT: case Luau::LOP_MINUS: case Luau::LOP_LENGTH:
            line << " R" << (int)A << " R" << (int)C; break;
        case Luau::LOP_NEWTABLE: line << " R" << (int)A << " hashSize " << (int)C; break;
        case Luau::LOP_DUPTABLE: line << " R" << (int)A << " K" << D; break;
        case Luau::LOP_SETLIST: line << " R" << (int)A << " R" << (int)C << " " << (int)B; break;
        case Luau::LOP_FORNPREP: line << " R" << (int)A << " " << (int)C; break;
        case Luau::LOP_FORNLOOP: line << " R" << (int)A; break;
        case Luau::LOP_FORGLOOP: line << " R" << (int)A << " " << (int)C; break;
        case Luau::LOP_FORGPREP: case Luau::LOP_FORGPREP_INEXT: case Luau::LOP_FORGPREP_NEXT:
            line << " R" << (int)A; break;
        case Luau::LOP_FASTCALL: line << " id " << (int)A; break;
        case Luau::LOP_FASTCALL1: line << " id " << (int)A << " R" << (int)C; break;
        case Luau::LOP_FASTCALL2: line << " id " << (int)A << " R" << (int)C << " R" << B; break;
        case Luau::LOP_FASTCALL2K: line << " id " << (int)A << " R" << (int)C << " K" << D; break;
        case Luau::LOP_FASTCALL3: line << " id " << (int)A << " R" << (int)C << " aux " << (inst >> 16); break;
        case Luau::LOP_COVERAGE: break;
        case Luau::LOP_CLOSEUPVALS: line << " R" << (int)A; break;
        case Luau::LOP_CAPTURE: line << " type " << (int)A << " " << (int)C; break;
        case Luau::LOP_PREPVARARGS: line << " " << (int)A; break;
        case Luau::LOP_GETVARARGS: line << " R" << (int)A; break;
        case Luau::LOP_LOADKX: line << " R" << (int)A; break;
        default: line << " " << (int)A << " " << (int)C << " " << (int)B; break;
    }
    return line.str();
}
