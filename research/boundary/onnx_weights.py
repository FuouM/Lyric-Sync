# Smaller ONNX files with the same graph:
#   fp16  every large float32 initializer is stored as float16 behind a Cast back to float32; the computation stays float32, only the weights
#         are rounded (half the file).
#   int8  weight-only int8 quantization of the MatMul weights (MatMulNBits, symmetric, per block of --block input rows; activations stay
#         float32), then fp16 for the remaining large initializers.
# usage: python scripts/onnx_weights.py <in.onnx> <out.onnx> fp16|int8 [--block 32]
import os
import sys

import numpy as np
import onnx
from onnx import helper, numpy_helper


def to_fp16_storage(model, min_elems=4096):
    """In place: large float32 initializers -> float16 initializers + Cast(to float32)."""
    g = model.graph
    casts = []
    keep = []
    for init in g.initializer:
        if init.data_type != onnx.TensorProto.FLOAT or np.prod(init.dims) < min_elems:
            keep.append(init)
            continue
        half = numpy_helper.from_array(numpy_helper.to_array(init).astype(np.float16), init.name + "_f16")
        keep.append(half)
        casts.append(helper.make_node("Cast", [half.name], [init.name], to=onnx.TensorProto.FLOAT, name=init.name + "_cast"))
    del g.initializer[:]
    g.initializer.extend(keep)
    nodes = list(g.node)
    del g.node[:]
    g.node.extend(casts + nodes)
    return model


def to_int8_matmul(model, block=32):
    """Weight-only int8 MatMul weights (onnxruntime's MatMulNBits)."""
    from onnxruntime.quantization.matmul_nbits_quantizer import DefaultWeightOnlyQuantConfig, MatMulNBitsQuantizer
    algo = DefaultWeightOnlyQuantConfig(block_size=block, is_symmetric=True, bits=8, op_types_to_quantize=("MatMul",))
    quant = MatMulNBitsQuantizer(model, block_size=block, is_symmetric=True, op_types_to_quantize=("MatMul",), algo_config=algo)
    quant.process()
    return quant.model.model


def convert(src, dst, mode, block=32):
    if mode not in ("fp16", "int8"):
        raise ValueError("mode must be fp16 or int8")
    model = onnx.load(src)
    if mode == "int8":
        model = to_int8_matmul(model, block)
    onnx.save(to_fp16_storage(model), dst)


if __name__ == "__main__":
    a = sys.argv
    convert(a[1], a[2], a[3], int(a[a.index("--block") + 1]) if "--block" in a else 32)
    print("%s -> %s (%s): %.1f MB -> %.1f MB" % (a[1], a[2], a[3], os.path.getsize(a[1]) / 1e6, os.path.getsize(a[2]) / 1e6))
