# Splits an ONNX model at its first GRU: "<stem>.encoder.onnx" = every node that does not depend on a GRU output,
# "<stem>.recurrent.onnx" = the GRUs, everything after them, and the weight-only nodes that feed them. The GPU runs the encoder
# (convolutions/transformer) and the CPU the recurrent part: DirectML's GRU is slow to warm up and fails on long sequences.
# On the CPU the two parts give exactly the output of the whole model. Ships as <stem>.encoder.onnx + <stem>.recurrent.onnx in
# models.json; run it on a newly exported frames.onnx (boundary model) or rmvpe.onnx, then `bun scripts/models.ts pack <dir>`.
# Needs Python with onnx and onnxruntime. The probe input (noise of the given shape) only finds the cut tensors' element types.
# usage: python scripts/split_gru.py <model.onnx> <out dir> <probe input name> <probe shape>
#   e.g. frames.onnx <dir> waveform 1x48000 ; rmvpe.onnx <dir> mel 1x128x320
import os
import sys

import numpy as np
import onnx
import onnxruntime as ort
from onnx import helper

src, out_dir, probe_name, probe_shape = sys.argv[1:5]
os.makedirs(out_dir, exist_ok=True)
model = onnx.load(src)
g = model.graph
nodes = list(g.node)

# Nodes downstream of the first GRU (data flow), GRU included.
first_gru = next(i for i, n in enumerate(nodes) if n.op_type == 'GRU')
tainted = set(nodes[first_gru].output)
rnn = {first_gru}
for i, n in enumerate(nodes):
    if i in rnn:
        continue
    if n.op_type == 'GRU' or any(x in tainted for x in n.input):
        rnn.add(i)
        tainted.update(n.output)
pre = [i for i in range(len(nodes)) if i not in rnn]

# Nodes that only read weights (no path from a graph input) and only feed the recurrent part move there, so the weights are
# not computed on the GPU and copied over on every run.
graph_input_names = {i.name for i in g.input}
dynamic = set(graph_input_names)
for n in nodes:
    if any(x in dynamic for x in n.input):
        dynamic.update(n.output)
consumers = {}
for i, n in enumerate(nodes):
    for x in n.input:
        consumers.setdefault(x, set()).add(i)
graph_outputs = {o.name for o in g.output}
for i in reversed(pre):
    n = nodes[i]
    if any(x in dynamic for x in n.input) or any(o in graph_outputs for o in n.output):
        continue
    users = set().union(*(consumers.get(o, set()) for o in n.output))
    if users and users <= rnn:
        rnn.add(i)
pre = [i for i in range(len(nodes)) if i not in rnn]
stem = os.path.splitext(os.path.basename(src))[0]

graph_inputs = {i.name for i in g.input}
inits = {i.name: i for i in g.initializer}
pre_outputs = {o for i in pre for o in nodes[i].output}
cut = []
for i in sorted(rnn):
    for x in nodes[i].input:
        if x and x in pre_outputs and x not in cut:
            cut.append(x)
rnn_graph_inputs = sorted({x for i in rnn for x in nodes[i].input if x in graph_inputs})
print('nodes pre', len(pre), 'rnn', len(rnn), 'cut tensors', cut, 'rnn graph inputs', rnn_graph_inputs)

# Element types of the cut tensors: run the original model with them exposed as outputs.
probe = onnx.load(src)
for name in cut:
    probe.graph.output.append(helper.make_empty_tensor_value_info(name))
dims = [int(d) for d in probe_shape.split('x')]
sess = ort.InferenceSession(probe.SerializeToString(), providers=['CPUExecutionProvider'])
feed = {probe_name: (np.random.default_rng(0).standard_normal(dims) * 0.05).astype(np.float32)}
outs = sess.run(cut, feed)
types = {name: helper.np_dtype_to_tensor_dtype(v.dtype) for name, v in zip(cut, outs)}
ranks = {name: v.ndim for name, v in zip(cut, outs)}
print({k: (str(v.dtype), v.shape) for k, v in zip(cut, outs)})


def value_info(name, elem, rank):
    return helper.make_tensor_value_info(name, elem, [f'{name}_d{k}' for k in range(rank)])


def make(part, inputs, outputs, path):
    used = {x for i in part for x in nodes[i].input}
    graph = helper.make_graph(
        [nodes[i] for i in part],
        os.path.basename(path),
        inputs,
        outputs,
        [inits[x] for x in sorted(used) if x in inits],
    )
    m = helper.make_model(graph, opset_imports=model.opset_import, ir_version=model.ir_version)
    onnx.save(m, path)
    print(path, os.path.getsize(path))


orig_inputs = {i.name: i for i in g.input}
make(pre, [i for i in g.input], [value_info(c, types[c], ranks[c]) for c in cut], os.path.join(out_dir, f'{stem}.encoder.onnx'))
make(sorted(rnn), [value_info(c, types[c], ranks[c]) for c in cut] + [orig_inputs[x] for x in rnn_graph_inputs], list(g.output), os.path.join(out_dir, f'{stem}.recurrent.onnx'))
