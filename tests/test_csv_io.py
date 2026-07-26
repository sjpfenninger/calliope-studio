"""Reading and writing the CSV data tables the grid editor shows.

Column type is inferred rather than declared, because a Calliope data table has
no schema saying which columns are numbers. Getting it wrong is quiet: a numeric
column read as text sorts "10" before "9", and a text column read as numeric
turns a node named `2005` into a number on the way back out.
"""

from calligraph.modeldef.csv_io import parse_csv


def parse(text: str) -> dict:
    return parse_csv(text.encode("utf-8"))


class TestTypeInference:
    def test_a_column_of_digits_is_numeric(self):
        assert parse("a,b\n1,2\n3,4\n")["columns"] == [
            {"name": "a", "type": "numeric"},
            {"name": "b", "type": "numeric"},
        ]

    def test_one_non_numeric_value_makes_the_column_text(self):
        # A single stray label is enough: the column cannot be a number column
        # if one of its values is not a number.
        columns = parse("a\n1\nn/a\n3\n")["columns"]
        assert columns == [{"name": "a", "type": "text"}]

    def test_an_empty_column_is_text(self):
        # Nothing to infer from, and text is the shape that loses nothing.
        assert parse("a,b\n,2\n,4\n")["columns"][0]["type"] == "text"

    def test_blanks_do_not_make_a_numeric_column_text(self):
        # A gap in a timeseries is normal and says nothing about the type.
        assert parse("a\n1\n\n3\n")["columns"][0]["type"] == "numeric"

    def test_decimals_and_exponents_are_numeric(self):
        assert parse("a\n0.5\n1e-3\n-2.5\n")["columns"][0]["type"] == "numeric"

    def test_a_column_of_dates_is_text(self):
        assert parse("t\n2005-01-01\n2005-01-02\n")["columns"][0]["type"] == "text"


class TestShape:
    def test_rows_come_back_as_written(self):
        assert parse("a,b\n1,x\n2,y\n")["rows"] == [["1", "x"], ["2", "y"]]

    def test_an_empty_file_has_no_columns(self):
        assert parse("") == {"columns": [], "rows": []}

    def test_a_header_with_no_rows_still_gives_columns(self):
        body = parse("a,b\n")
        assert [column["name"] for column in body["columns"]] == ["a", "b"]
        assert body["rows"] == []

    def test_a_ragged_row_does_not_break_inference(self):
        # Real files have them, usually a trailing comma somewhere.
        body = parse("a,b\n1\n2,3\n")
        assert body["columns"][1]["type"] == "numeric"

    def test_a_byte_order_mark_is_not_part_of_the_first_column_name(self):
        # Excel writes one, and it would otherwise become part of the header,
        # so the column would not match the dimension it names.
        assert parse("﻿nodes,value\nregion1,1\n")["columns"][0]["name"] == "nodes"
