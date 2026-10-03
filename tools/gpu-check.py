# -*- coding: utf-8 -*-
"""换机/GPU 自检：确认 torch 与 onnxruntime 是否真的在用 GPU。

用法：
    .venv-p2t\\Scripts\\python.exe tools\\gpu-check.py          # 快速检查（几秒）
    .venv-p2t\\Scripts\\python.exe tools\\gpu-check.py --full   # 完整检查（会加载 OCR 模型，约 30s）

背景：onnxruntime 的 CUDA provider"可用"不等于"真的在用"。
版本不匹配时它会静默回落到 CPU，只有实际建会话 + 跑一次推理才能确认。
"""
import argparse
import os
import sys
from pathlib import Path

# Windows 控制台默认 GBK，置为 UTF-8 避免中文/符号报错（失败则忽略）
try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

# 允许从任意目录调用本脚本（ppt2md / dedup 在项目根）
_ROOT = Path(__file__).resolve().parent.parent
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

OK = '  [OK]'
WARN = '  [!]'
FAIL = '  [X]'


def add_torch_dll_dir():
    """与 ppt2md.py 相同的处理：把 torch/lib 加进 DLL 搜索路径，供 ORT 找到 cudnn/cublasLt。"""
    try:
        import torch
        lib = os.path.join(os.path.dirname(torch.__file__), 'lib')
        if os.path.isdir(lib):
            os.environ['PATH'] = lib + os.pathsep + os.environ.get('PATH', '')
            if hasattr(os, 'add_dll_directory'):
                os.add_dll_directory(lib)
            return lib
    except Exception:
        pass
    return None


def check_torch():
    print('[1] PyTorch')
    try:
        import torch
    except Exception as e:
        print(f'{FAIL} 未安装 torch：{e}')
        return False
    print(f'  版本: {torch.__version__}')
    if torch.cuda.is_available():
        name = torch.cuda.get_device_name(0)
        cap = torch.cuda.get_device_capability(0)
        print(f'{OK} CUDA 可用：{name} (sm_{cap[0]}{cap[1]})')
        return True
    print(f'{FAIL} CUDA 不可用（将回落 CPU）')
    return False


def check_ort():
    print('[2] ONNX Runtime（文本 OCR / 公式识别用）')
    try:
        import onnxruntime as ort
    except Exception as e:
        print(f'{FAIL} 未安装 onnxruntime：{e}')
        return False

    providers = ort.get_available_providers()
    print(f'  版本: {ort.__version__}')
    print(f'  可用 providers: {providers}')
    if 'CUDAExecutionProvider' not in providers:
        print(f'{FAIL} 没有 CUDAExecutionProvider（装了 CPU 版？或 CUDA/cuDNN 缺失）')
        return False

    # 真的建一个会话并跑推理，确认 CUDA 内核存在（V100 等老卡常见 "no kernel image"）
    try:
        import numpy as np
        import onnx
        from onnx import helper, TensorProto

        x = helper.make_tensor_value_info('x', TensorProto.FLOAT, [2, 2])
        y = helper.make_tensor_value_info('y', TensorProto.FLOAT, [2, 2])
        node = helper.make_node('Relu', ['x'], ['y'])
        graph = helper.make_graph([node], 'g', [x], [y])
        model = helper.make_model(graph, ir_version=10, opset_imports=[helper.make_opsetid('', 17)])
        mf = Path(__file__).parent / '_gpu_check.onnx'
        onnx.save(model, str(mf))

        sess = ort.InferenceSession(str(mf), providers=['CUDAExecutionProvider', 'CPUExecutionProvider'])
        active = sess.get_providers()
        out = sess.run(None, {'x': np.array([[-1, 2], [3, -4]], dtype=np.float32)})[0]
        mf.unlink(missing_ok=True)

        if active and active[0] == 'CUDAExecutionProvider':
            print(f'{OK} 会话实际使用 CUDA（providers={active}）')
            return True
        print(f'{FAIL} 会话回落到了 {active}（CUDA provider 加载失败，常见原因：CUDA/cuDNN 版本不匹配）')
        return False
    except Exception as e:
        print(f'{FAIL} CUDA 会话创建/推理失败：{str(e)[:200]}')
        print('       提示：CUDA 12.4 需要 NVIDIA 驱动 R550+；cuDNN 9 的 DLL 由 torch 自带。')
        return False


def check_full():
    print('[3] Pix2Text 完整链路（布局 + 文本 + 公式）')
    try:
        import ppt2md  # 触发 DLL 路径与版面 device 补丁
        from pix2text import Pix2Text

        img = None
        dl = Path(__file__).parent.parent / 'downloads'
        if dl.is_dir():
            for course in dl.iterdir():
                if not course.is_dir():
                    continue
                for lesson in course.iterdir():
                    if not lesson.is_dir():
                        continue
                    jpgs = sorted(lesson.glob('*.jpg'))
                    if jpgs:
                        img = str(jpgs[0])
                        break
                if img:
                    break

        if not img:
            print(f'{WARN} downloads/ 下没有图片，跳过热推理（模型加载仍会检查）')
            p2t = Pix2Text.from_config(device='cuda')
        else:
            p2t = Pix2Text.from_config(device='cuda')
            page = p2t.recognize(img, file_type='page', return_text=True)
            print(f'{OK} 单页识别成功：{len(page.elements)} 个元素（{Path(img).name}）')

        lp = p2t.layout_parser
        dev = next(lp.predictor.model.parameters()).device
        print(f'{OK if "cuda" in str(dev) else WARN} 版面模型设备：{dev}')
        return True
    except Exception as e:
        print(f'{FAIL} 完整链路失败：{str(e)[:200]}')
        return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--full', action='store_true', help='额外做一次真实 OCR 推理')
    args = ap.parse_args()

    lib = add_torch_dll_dir()
    if lib:
        print(f'  (已把 torch/lib 加入 DLL 搜索路径: {lib})')
    print()

    ok_torch = check_torch()
    print()
    ok_ort = check_ort()
    ok_full = True
    if args.full and ok_ort:
        print()
        ok_full = check_full()

    print()
    if ok_torch and ok_ort and ok_full:
        print('结论：GPU 链路正常')
        sys.exit(0)
    print('结论：存在回落 CPU 的环节，请看上面的 [!] / [X] 提示')
    sys.exit(1)


if __name__ == '__main__':
    main()
