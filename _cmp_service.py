import os, hashlib

def walk(d):
    r = {}
    for rt, _, fs in os.walk(d):
        if '__pycache__' in rt:
            continue
        for f in fs:
            if f.endswith('.pyc'):
                continue
            p = os.path.relpath(os.path.join(rt, f), d)
            try:
                r[p] = hashlib.md5(open(os.path.join(rt, f), 'rb').read()).hexdigest()
            except Exception:
                pass
    return r

A = walk('service')
B = walk('OpenHarness/service')
print('=== only in TOP service/ ===')
for p in sorted(set(A) - set(B)):
    print('  ', p)
print('=== only in OpenHarness/service/ ===')
for p in sorted(set(B) - set(A)):
    print('  ', p)
print('=== both, CONTENT DIFFERS ===')
for p in sorted(set(A) & set(B)):
    if A[p] != B[p]:
        print('  ', p)
print('=== both, identical:', len([p for p in set(A) & set(B) if A[p] == B[p]]), 'files ===')
