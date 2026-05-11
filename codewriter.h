// codewriter.h
#pragma once
#include "structurizer.h"
#include <string>

class CodeWriter : public StmtVisitor {
public:
    CodeWriter() = default;
    std::string generate(Stmt& program);
    void visit(IfStmt&) override;
    void visit(WhileStmt&) override;
    void visit(RepeatStmt&) override;
    void visit(NumericForStmt&) override;
    void visit(GenericForStmt&) override;
    void visit(AssignStmt&) override;
    void visit(CallStmt&) override;
    void visit(ReturnStmt&) override;
    void visit(BlockStmt&) override;
private:
    std::string exprToString(Expr& expr);
    std::string m_result;
    int m_indent = 0;
    void newline();
    void indent();
};
