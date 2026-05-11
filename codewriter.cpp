// codewriter.cpp
#include "codewriter.h"

std::string CodeWriter::generate(Stmt& program) {
    program.accept(*this);
    return m_result;
}

void CodeWriter::newline() { m_result += "\n" + std::string(m_indent * 4, ' '); }
void CodeWriter::indent() { m_indent++; }
void CodeWriter::visit(IfStmt&) {}
void CodeWriter::visit(WhileStmt&) {}
void CodeWriter::visit(RepeatStmt&) {}
void CodeWriter::visit(NumericForStmt&) {}
void CodeWriter::visit(GenericForStmt&) {}
void CodeWriter::visit(AssignStmt&) {}
void CodeWriter::visit(CallStmt&) {}
void CodeWriter::visit(ReturnStmt&) {}
void CodeWriter::visit(BlockStmt& s) { for (auto& st : s.stmts) st->accept(*this); }
std::string CodeWriter::exprToString(Expr& expr) { return ""; }
