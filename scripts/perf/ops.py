# Lists the nodes of an ONNX model with their attributes and initializer shapes (op types filtered by argv[2], comma list).
# usage: python scripts/perf/ops.py <model.onnx> [Conv,GRU]
import sys
from collections import Counter

import onnx
from onnx import helper, numpy_helper

m = onnx.load(sys.argv[1], load_external_data=False)
want = set(sys.argv[2].split(',')) if len(sys.argv) > 2 else None
inits = {i.name: list(i.dims) for i in m.graph.initializer}
print('opset', [(o.domain, o.version) for o in m.opset_import])
print('inputs', [(i.name, [d.dim_value or d.dim_param for d in i.type.tensor_type.shape.dim]) for i in m.graph.input])
print('counts', Counter(n.op_type for n in m.graph.node).most_common())
for n in m.graph.node:
    if want and n.op_type not in want:
        continue
    attrs = {a.name: helper.get_attribute_value(a) for a in n.attribute}
    attrs = {k: (v if not isinstance(v, bytes) else v.decode()) for k, v in attrs.items() if not hasattr(v, 'dims')}
    print(n.op_type, n.name, attrs, [inits.get(i) for i in n.input])
