"""Run each tool's independent suite (Python 3.13+); no JumpCode checkout needed."""
from pathlib import Path
import os
import subprocess
import sys

root = Path(__file__).resolve().parents[1]
failed = []
for tool in sorted((root / 'tools').iterdir()):
    if not (tool / 'tests').is_dir():
        continue
    print(f'\n--- {tool.name} ---', flush=True)
    env = dict(os.environ, PYTHONPATH=str(tool / 'src'), PYTHONDONTWRITEBYTECODE='1')
    # The optional real 3D model test needs an explicitly supplied engine; fixtures run everywhere.
    env.setdefault('JUMPCODE_GENERATOR3D_ENGINE', str(root / '.optional-3d-engine'))
    result = subprocess.run([sys.executable, '-m', 'unittest', 'discover', '-s', str(tool / 'tests'), '-p', 'test_*.py'], cwd=root, env=env)
    if result.returncode:
        failed.append(tool.name)
print('Failed suites: ' + ', '.join(failed) if failed else 'All tool suites passed.')
sys.exit(bool(failed))
