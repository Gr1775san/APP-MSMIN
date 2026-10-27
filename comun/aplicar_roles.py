"""Aplica el módulo MSMIN_ROLES al Código.gs de una app.
uso: python3 aplicar_roles.py entrada.gs salida.gs config.js
config.js: texto JS con  const MSMIN_PERMISOS = {...}; const MSMIN_OCULTAR = {...}; (y opcional function msminNivelPost_(e){...})
Renombra doGet/doPost -> appGet_/appPost_ y cada función de MSMIN_PERMISOS -> nombre_ (y sus llamadas)."""
import re, sys, os
ent, sal, cfg = sys.argv[1:4]
s = open(ent, encoding='utf-8').read()
c = open(cfg, encoding='utf-8').read()
mod = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'msmin-roles.gs'), encoding='utf-8').read()
if 'MSMIN_ROLES' in s: sys.exit('ya tiene MSMIN_ROLES')
s = re.sub(r'\bfunction\s+doGet\s*\(', 'function appGet_(', s)
s = re.sub(r'\bfunction\s+doPost\s*\(', 'function appPost_(', s)
s = re.sub(r'(?<![\w.$])doGet\s*\(', 'appGet_(', s)
s = re.sub(r'(?<![\w.$])doPost\s*\(', 'appPost_(', s)
perm = re.search(r'MSMIN_PERMISOS\s*=\s*\{(.*?)\}', c, re.S).group(1)
fns = re.findall(r'(\w+)\s*:', perm)
for f in fns:
    n = len(re.findall(r'\b' + f + r'\b(?=\s*\()', s))
    s = re.sub(r'(?<![\w$])' + f + r'\b(?=\s*\()', f + '_', s)
    print(f, n)
open(sal, 'w', encoding='utf-8').write(s.rstrip() + '\n\n' + c.strip() + '\n\n' + mod)
