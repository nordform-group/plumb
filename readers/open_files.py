# SPDX-License-Identifier: Apache-2.0
"""Open delivered concept IFC and DXF bytes with the independent readers (Nordform Plumb).

Usage: python3 readers/open_files.py <dir>, where <dir>/manifest.json lists
[{"case", "file", "format": "ifc"|"dxf", "sha256"}]. Our own parser never counts as evidence
here: a file is "opened" only when ifcopenshell or ezdxf reads it and finds the content a
concept model must have. Prints one JSON object; a missing reader is a failure, not a skip.
"""
import hashlib
import json
import sys
from pathlib import Path

import ezdxf
import ifcopenshell

root = Path(sys.argv[1])
rows = []
for entry in json.loads((root / 'manifest.json').read_text()):
    path = root / entry['file']
    row = {'case': entry['case'], 'format': entry['format'], 'file': entry['file']}
    try:
        data = path.read_bytes()
        assert hashlib.sha256(data).hexdigest() == entry['sha256'], 'bytes differ from the delivery record'
        if entry['format'] == 'ifc':
            model = ifcopenshell.open(str(path))
            projects = model.by_type('IfcProject')
            assert len(projects) == 1, 'IFC must hold exactly one IfcProject'
            units = projects[0].UnitsInContext.Units
            assert any(u.is_a('IfcSIUnit') and u.UnitType == 'LENGTHUNIT' and u.Name == 'METRE' and u.Prefix is None
                       for u in units), 'IFC length unit must be the metre'
            products = model.by_type('IfcProduct')
            assert products, 'IFC holds no products'
            row.update(schema=model.schema, products=len(products))
        else:
            doc = ezdxf.readfile(path)
            auditor = doc.audit()
            assert not auditor.has_errors, f'ezdxf audit found {len(auditor.errors)} error(s)'
            entities = len(doc.modelspace())
            assert entities > 0, 'DXF modelspace is empty'
            row.update(insunits=doc.header.get('$INSUNITS'), entities=entities)
        row['status'] = 'opened'
    except Exception as error:  # every failure is reported per file, never raised past the run
        row.update(status='failed', reason=str(error)[:300])
    rows.append(row)
print(json.dumps({'readers': {'ezdxf': ezdxf.__version__, 'ifcopenshell': ifcopenshell.version}, 'files': rows}))
