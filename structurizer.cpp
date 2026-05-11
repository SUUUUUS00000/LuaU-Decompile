// structurizer.cpp
#include "structurizer.h"
#include "BytecodeUtils.h"
#include "luau/Bytecode.h"

Structurizer::Structurizer(const BytecodeReader::FunctionProto& func, const BytecodeReader& reader)
    : m_func(func), m_reader(reader) {
    m_cfg.build(func.instructions);
}

static int constantIndex(const BytecodeReader::FunctionProto& func, int idx) {
    if (idx < func.kNumber.size()) return idx;
    idx -= func.kNumber.size();
    if (idx < func.kInteger.size()) return idx;
    idx -= func.kInteger.size();
    if (idx < func.kString.size()) return idx;
    return -1;
}

static std::unique_ptr<Expr> loadConstant(const BytecodeReader::FunctionProto& func, int idx) {
    int kind = -1;
    if (idx < func.kNumber.size()) { kind = 0; }
    else if (idx < func.kNumber.size() + func.kInteger.size()) { kind = 1; }
    else if (idx < func.kNumber.size() + func.kInteger.size() + func.kString.size()) { kind = 2; }
    auto c = std::make_unique<ConstExpr>();
    switch (kind) {
    case 0: c->num = func.kNumber[idx]; break;
    case 1: c->intval = func.kInteger[idx - func.kNumber.size()]; break;
    case 2: c->str = func.kString[idx - func.kNumber.size() - func.kInteger.size()]; break;
    default: break;
    }
    return c;
}

static std::unique_ptr<Expr> buildExpr(const BytecodeReader::FunctionProto& func, const std::vector<uint32_t>& insns, uint32_t start, uint32_t end, uint32_t targetReg) {
    return std::make_unique<VarExpr>("unknown");
}

std::unique_ptr<BlockStmt> Structurizer::structurize() {
    return buildAst();
}

std::unique_ptr<BlockStmt> Structurizer::buildAst() {
    auto root = std::make_unique<BlockStmt>();
    return root;
}
