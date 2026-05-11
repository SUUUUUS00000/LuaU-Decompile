// main.cpp
#include "external/httplib.h"
#include "external/json.hpp"
#include "base64.h"
#include "bytecode_reader.h"
#include "structurizer.h"
#include "codewriter.h"
#include <iostream>
#include <sstream>
#include <iomanip>

using json = nlohmann::json;

std::string hexdump(const std::vector<uint8_t>& data, size_t max_len) {
    std::ostringstream oss;
    size_t n = std::min(data.size(), max_len);
    for (size_t i = 0; i < n; ++i) {
        oss << std::hex << std::uppercase << std::setw(2) << std::setfill('0') 
            << (int)data[i] << " ";
    }
    if (data.size() > max_len) oss << "...";
    return oss.str();
}

int main() {
    httplib::Server svr;

    svr.Get("/", [](const httplib::Request &req, httplib::Response &res) {
        res.set_content("Luau Decompiler API is running. Send POST to /decompile", "text/plain");
    });

    svr.Post("/decompile", [](const httplib::Request &req, httplib::Response &res) {
        try {
            json body = json::parse(req.body);
            if (!body.contains("script")) {
                res.status = 400;
                res.set_content("Missing 'script' field", "text/plain");
                return;
            }
            std::string base64_encoded = body["script"].get<std::string>();
            auto bytecode_vec = base64_decode(base64_encoded);
            if (bytecode_vec.empty()) {
                res.status = 400;
                res.set_content("Invalid base64 data", "text/plain");
                return;
            }

            BytecodeReader reader;
            if (!reader.load(bytecode_vec)) {
                std::string error_msg = "Failed to parse bytecode: " + reader.getLastError() +
                                        ". First bytes: " + hexdump(bytecode_vec, 32);
                res.status = 500;
                res.set_content(error_msg, "text/plain");
                return;
            }

            std::string result;
            const BytecodeReader::FunctionProto* mainFunc = reader.getFunction(reader.getMainFunctionId());
            if (mainFunc) {
                Structurizer structurizer(*mainFunc, reader);
                auto ast = structurizer.structurize();
                CodeWriter writer;
                result = writer.generate(*ast);
            } else {
                result = "-- no main function";
            }

            res.set_content(result, "text/plain");
        } catch (const std::exception &e) {
            std::cerr << "Error: " << e.what() << std::endl;
            res.status = 500;
            res.set_content(std::string("Error: ") + e.what(), "text/plain");
        }
    });

    std::cout << "Luau Decompiler server running on http://localhost:8080" << std::endl;
    svr.listen("0.0.0.0", 8080);
    return 0;
}
