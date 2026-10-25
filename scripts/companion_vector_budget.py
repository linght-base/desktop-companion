# Copyright (c) 2026 Shenzhen Guangbo Technology Co., Ltd.
# SPDX-License-Identifier: Apache-2.0
"""Fit native label outlines without replacing readable text with a status symbol."""
from math import inf


def fit_label_strokes(strokes, max_strokes, max_points):
    paths = [list(path) for path in strokes if path]
    # Join the closest contour endpoints with a short hairline. Closed contours
    # can rotate to their closest vertex, retaining every original outline.
    def ends(path):
        return range(len(path)-1) if len(path)>2 and path[0]==path[-1] else (0, len(path)-1)
    def orient(path, index, last=False):
        if len(path)>2 and path[0]==path[-1]:
            ring=path[:-1];ring=ring[index:]+ring[:index]
            return ring+[ring[0]]
        return path[::-1] if (last and index==0) or (not last and index==len(path)-1) else path
    while len(paths)>max_strokes:
        best=(inf,None)
        for a in range(len(paths)):
            for b in range(a+1,len(paths)):
                if len(paths[a])+len(paths[b])>48:continue
                for i in ends(paths[a]):
                    for j in ends(paths[b]):
                        x,y=paths[a][i];u,v=paths[b][j]
                        distance=(x-u)**2+(y-v)**2
                        if distance<best[0]:best=(distance,(a,b,i,j))
        if best[1] is None:raise ValueError('label stroke budget')
        a,b,i,j=best[1];paths[a]=orient(paths[a],i,True)+orient(paths[b],j);paths.pop(b)
    # Remove lowest-error interior vertices, retaining endpoints and corners.
    while sum(map(len,paths))>max_points:
        best=(inf,None)
        for a,path in enumerate(paths):
            if len(path)<=3:continue
            for i in range(1,len(path)-1):
                x,y=path[i-1];u,v=path[i];z,w=path[i+1]
                area=abs((u-x)*(w-y)-(v-y)*(z-x))
                if area<best[0]:best=(area,(a,i))
        if best[1] is None:raise ValueError('label point budget')
        a,i=best[1];paths[a].pop(i)
    return paths
