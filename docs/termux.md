# Termux / Android setup

On **Termux (Android)**, the `postinstall` venv build can fail because `ipykernel` depends on
`psutil`, and PyPI does not provide a compatible Android wheel. Two common alternatives do not
solve the problem:

- `pkg install python-psutil`: Termux's `.deb` post-install runs the same failing `pip install
  psutil`, so no usable psutil is left.
- `pip install psutil-android`: the prebuilt `.so` links `libpython3.14.so`; on an older
  Termux Python it fails with `dlopen failed: library "libpython3.14.so" not found`. It works
  only when Termux's Python matches the wheel's ABI (currently 3.14).

The reliable route is to build the documented `psutil` release from source with a small
Android-specific change, then install the evaluator venv. Run these commands from a writable
working directory. If the release changes, update the source URL, version numbers, and patch
before running them:

```bash
# 1. show a compiler + Python headers
pkg install clang python

# 2. fetch and patch the psutil source so Android counts as Linux
curl -sL -o psutil.tar.gz https://files.pythonhosted.org/packages/source/p/psutil/psutil-7.2.2.tar.gz && tar -xzf psutil.tar.gz
cd psutil-7.2.2
sed -i 's/LINUX = sys.platform.startswith("linux")/LINUX = sys.platform.startswith(("linux", "android"))/' psutil/_common.py
python3 setup.py bdist_wheel
# If this reports that wheel is missing:
python3 -m pip install wheel

# 3. (re)build the evaluator venv and install the patched wheel first
python3 -m venv --clear ~/.pi/agent/pi-repl/venv
~/.pi/agent/pi-repl/venv/bin/pip install dist/psutil-7.2.2-*.whl
~/.pi/agent/pi-repl/venv/bin/pip install ipykernel

# 4. finish the package install
pi install npm:pi-repl-py

# 5. verify
~/.pi/agent/pi-repl/venv/bin/python3 -c "import psutil, ipykernel; print(psutil.__version__, ipykernel.__version__)"
```

The final command checks that both packages import successfully. Then start pi-repl:

```bash
pi --repl
```

The venv already contains the working `ipykernel` that the evaluator needs.

