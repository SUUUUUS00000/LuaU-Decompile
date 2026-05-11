// structurizer.cpp
#include "structurizer.h"
#include "BytecodeUtils.h"
#include "luau/Bytecode.h"

Structurizer::Structurizer(const BytecodeReader::FunctionProto& func, const BytecodeReader& reader)
    : m_func(func), m_reader(reader) {
    m_cfg.build(func.instructions);
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
