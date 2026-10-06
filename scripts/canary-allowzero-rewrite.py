"""Clear Reshape allowzero on the Canary fp32 encoder graph.

onnxruntime's CUDA provider rejects allowzero Reshapes. Canary has no zero-size
shape dims, so allowzero=0 computes the same result. Weights stay in the
same-directory encoder-model.onnx.data file.
"""

import sys

import onnx


def main(src: str, dst: str) -> None:
    model = onnx.load(src, load_external_data=False)
    for node in model.graph.node:
        if node.op_type == "Reshape":
            for attribute in node.attribute:
                if attribute.name == "allowzero":
                    attribute.i = 0
    for initializer in model.graph.initializer:
        if initializer.data_location == onnx.TensorProto.EXTERNAL:
            for entry in initializer.external_data:
                if entry.key == "location":
                    entry.value = "encoder-model.onnx.data"
    onnx.save(model, dst, save_as_external_data=False)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
