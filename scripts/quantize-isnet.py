"""Build public/models/isnet_general_q.onnx from IS-Net general-use.

Source (Apache-2.0, https://github.com/xuebinqin/DIS), via rembg:
  https://github.com/danielgatis/rembg/releases/download/v0.0.0/isnet-general-use.onnx

Usage (any venv with `onnxruntime onnx numpy`):
  python scripts/quantize-isnet.py isnet-general-use.onnx public/models/isnet_general_q.onnx

Dynamic uint8 weights everywhere except the convs the matte is most sensitive
to — the input conv, the two finest decoder stages and the side heads — which
stay fp32. Spike (2026-10-21, 8 people/product photos): plain full int8 left
background speckle on 3 of 8 images; this variant is ~46.8MB and within 0.6%
mean alpha of fp32 on 7 of 8 (1.8% on white headphones on white).
"""
import os
import sys
import tempfile

import onnx
from onnxruntime.quantization import QuantType, quantize_dynamic
from onnxruntime.quantization.shape_inference import quant_pre_process

KEEP_FP32 = ('/conv_in/', '/stage1d/', '/stage2d/', '/side')


def main(src: str, out: str) -> None:
    with tempfile.TemporaryDirectory() as tmp:
        pre = os.path.join(tmp, 'pre.onnx')
        quant_pre_process(src, pre, skip_symbolic_shape=True)
        graph = onnx.load(pre).graph
        exclude = [n.name for n in graph.node if n.op_type == 'Conv' and n.name.startswith(KEEP_FP32)]
        quantize_dynamic(pre, out, weight_type=QuantType.QUInt8, nodes_to_exclude=exclude)
    print(f'{out}: {os.path.getsize(out):,} bytes, {len(exclude)} convs kept fp32')


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
