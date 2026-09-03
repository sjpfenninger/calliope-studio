"""CSV data tables as the grid editor sees them.

Deliberately format-preserving in the weak sense: rows are carried as lists of
strings and written back verbatim, so editing one cell cannot reformat numbers
elsewhere in the file. Type detection is advisory — it only tells the grid which
editor to offer.
"""

import codecs
import csv
import io


def sniff_format(head: bytes) -> tuple[bool, str]:
    """What a save has to put back that the parser threw away.

    `parse_csv` decodes as `utf-8-sig`, which strips a byte-order mark, and
    `csv.reader` accepts either line ending. Neither is data — but an Excel
    export has both, and a grid edit that came back without them was a wholly
    different file to a diff, and one Excel then misread for non-ASCII names.

    Returns:
        `(bom, lineterminator)` for `serialize_csv`.
    """
    bom = head.startswith(codecs.BOM_UTF8)
    lineterminator = "\r\n" if b"\r\n" in head else "\n"
    return bom, lineterminator


def parse_csv(content: bytes) -> dict:
    """Parses CSV bytes into columns and rows for the grid editor.

    Column types are inferred from the values actually present: a column is
    numeric only if every non-empty value parses as a float.
    """
    reader = csv.reader(io.StringIO(content.decode("utf-8-sig")))
    rows = list(reader)
    if not rows:
        return {"columns": [], "rows": []}

    headers, data_rows = rows[0], rows[1:]

    columns = []
    for index, header in enumerate(headers):
        values = [
            row[index] for row in data_rows if index < len(row) and row[index] != ""
        ]
        column_type = "text"
        if values:
            try:
                for value in values:
                    float(value)
                column_type = "numeric"
            except ValueError:
                column_type = "text"
        columns.append({"name": header, "type": column_type})

    return {"columns": columns, "rows": data_rows}


def serialize_csv(
    columns: list[dict],
    rows: list[list],
    *,
    bom: bool = False,
    lineterminator: str = "\n",
) -> bytes:
    """Writes columns and rows back out as CSV, in the format `sniff_format` found."""
    output = io.StringIO()
    writer = csv.writer(output, lineterminator=lineterminator)
    writer.writerow([column["name"] for column in columns])
    writer.writerows(rows)
    data = output.getvalue().encode("utf-8")
    return codecs.BOM_UTF8 + data if bom else data
