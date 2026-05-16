#define PY_SSIZE_T_CLEAN
#include <Python.h>

/* Simple C-extension to speed up basic token estimation (chars/4)
   and perhaps some JSON-like string scanning if needed. */

static PyObject* method_estimate_tokens(PyObject* self, PyObject* args) {
    const char* text;
    if (!PyArg_ParseTuple(args, "s", &text)) {
        return NULL;
    }

    size_t len = strlen(text);
    long tokens = (long)(len / 4);
    if (tokens == 0 && len > 0) tokens = 1;

    return PyLong_FromLong(tokens);
}

static PyMethodDef PerformanceMethods[] = {
    {"estimate_tokens", method_estimate_tokens, METH_VARARGS, "Estimate token count based on characters."},
    {NULL, NULL, 0, NULL}
};

static struct PyModuleDef performancemodule = {
    PyModuleDef_HEAD_INIT,
    "performance",
    "Performance critical functions in C.",
    -1,
    PerformanceMethods
};

PyMODINIT_FUNC PyInit_performance(void) {
    return PyModule_Create(&performancemodule);
}
