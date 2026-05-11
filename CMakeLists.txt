# CMakeLists.txt
cmake_minimum_required(VERSION 3.10)
project(LuauDecompiler)

set(CMAKE_CXX_STANDARD 17)

include_directories(${CMAKE_SOURCE_DIR} ${CMAKE_SOURCE_DIR}/luau)

add_executable(luau-decompiler main.cpp bytecode_reader.cpp disassembler.cpp)
