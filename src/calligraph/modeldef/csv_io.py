"""CSV data tables as the grid editor sees them.

Deliberately format-preserving in the weak sense: rows are carried as lists of
strings and written back verbatim, so editing one cell cannot reformat numbers
elsewhere in the file. Type detection is advisory — it only tells the grid which
editor to offer.
"""

import csv
import io


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


def serialize_csv(columns: list[dict], rows: list[list]) -> bytes:
    """Writes columns and rows back out as CSV."""
    output = io.StringIO()
    writer = csv.writer(output, lineterminator="\n")
    writer.writerow([column["name"] for column in columns])
    writer.writerows(rows)
    return output.getvalue().encode()
