package main

import "testing"

func TestEvalClamp(t *testing.T) {
	cases := []struct{ v, lo, hi, want int }{{5, 0, 10, 5}, {-3, 0, 10, 0}, {12, 0, 10, 10}, {0, 0, 10, 0}, {10, 0, 10, 10}}
	for _, c := range cases {
		if got := Clamp(c.v, c.lo, c.hi); got != c.want {
			t.Errorf("Clamp(%d, %d, %d) = %d, want %d", c.v, c.lo, c.hi, got, c.want)
		}
	}
}
