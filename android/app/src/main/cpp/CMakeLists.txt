cmake_minimum_required(VERSION 3.22)
project(desicaps_jni C CXX)

# whisper.cpp source is cloned here by CI (see packaging/github/build.yml -> android job)
set(WCPP ${CMAKE_CURRENT_SOURCE_DIR}/whisper.cpp)
if(NOT EXISTS ${WCPP}/CMakeLists.txt)
    message(FATAL_ERROR "whisper.cpp source missing: clone it into ${WCPP}")
endif()

include(ExternalProject)
find_library(LOG_LIB log)

# Two builds of whisper.cpp: baseline ARMv8.0 (old budget phones) and ARMv8.2 with fp16 + dotprod
# (most phones since ~2018, much faster). Java picks one at runtime from /proc/cpuinfo.
function(whisper_variant NAME ARM_ARCH)
    set(PREFIX ${CMAKE_BINARY_DIR}/wcpp_${NAME})
    set(LIBS ${PREFIX}/lib/libwhisper.a ${PREFIX}/lib/libggml.a ${PREFIX}/lib/libggml-cpu.a ${PREFIX}/lib/libggml-base.a)
    ExternalProject_Add(wcpp_${NAME}
        SOURCE_DIR ${WCPP}
        BINARY_DIR ${CMAKE_BINARY_DIR}/wcpp_${NAME}_build
        INSTALL_DIR ${PREFIX}
        CMAKE_ARGS
            -DCMAKE_TOOLCHAIN_FILE=${CMAKE_TOOLCHAIN_FILE}
            -DANDROID_ABI=${ANDROID_ABI}
            -DANDROID_PLATFORM=${ANDROID_PLATFORM}
            -DANDROID_NDK=${ANDROID_NDK}
            -DANDROID_STL=c++_static
            -DCMAKE_MAKE_PROGRAM=${CMAKE_MAKE_PROGRAM}
            -DCMAKE_BUILD_TYPE=Release
            -DCMAKE_INSTALL_PREFIX=${PREFIX}
            -DCMAKE_INSTALL_LIBDIR=lib
            -DCMAKE_POSITION_INDEPENDENT_CODE=ON
            -DBUILD_SHARED_LIBS=OFF
            -DGGML_NATIVE=OFF
            -DGGML_OPENMP=OFF
            -DGGML_LLAMAFILE=OFF
            -DGGML_CPU_ARM_ARCH=${ARM_ARCH}
            -DWHISPER_BUILD_TESTS=OFF
            -DWHISPER_BUILD_EXAMPLES=OFF
            -DWHISPER_BUILD_SERVER=OFF
            -DWHISPER_SDL2=OFF
        BUILD_BYPRODUCTS ${LIBS}
    )
    add_library(${NAME} SHARED jni.cpp)
    add_dependencies(${NAME} wcpp_${NAME})
    target_include_directories(${NAME} PRIVATE ${WCPP}/include ${WCPP}/ggml/include)
    target_compile_options(${NAME} PRIVATE -O3 -fvisibility=hidden)
    target_link_options(${NAME} PRIVATE -Wl,--gc-sections -Wl,--exclude-libs,ALL)
    target_link_libraries(${NAME} ${LIBS} ${LOG_LIB} android m)
endfunction()

whisper_variant(whisperjni_v8 armv8-a)
whisper_variant(whisperjni_v82 armv8.2-a+fp16+dotprod)
