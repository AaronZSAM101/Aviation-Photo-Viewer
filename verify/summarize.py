import json
import sys

d = json.load(sys.stdin)
s = d["scroll"]
print(
    "{}x listReady={}ms mount={}ms longTasks={} longTotal={} longMax={} frames={} janky={} avg={} worst={} heap={}MB".format(
        d["throttle"],
        d["listReadyMs"],
        d["allCardsMs"],
        d["longTasks"],
        d["longTotal"],
        d["longMax"],
        s["frames"],
        s["janky"],
        s["avg"],
        s["worst"],
        d["heapMB"],
    )
)
