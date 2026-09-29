; CALL and RET: into a subroutine and back, to the instruction after the
; CALL; a subroutine called twice; and one level only — a CALL inside a
; subroutine overwrites the link register, as ISA.md says.
;! log=1,2,3,2,4,5,5,5,5
;! A=5 X=3

        LDX #0
        LDA #1
        OUT 3           ; 1
        CALL two        ; logs 2, X+1
        LDA #3
        OUT 3           ; 3
        CALL two        ; logs 2 again, X+1
        LDA #4
        OUT 3           ; 4
        ; A nested CALL: `outer` calls `five`, whose RET comes back into
        ; `outer` — and then `outer`'s own RET goes there again, because
        ; the link register now holds that address. `outer` counts its
        ; passes in X and stops the second time round.
        CALL outer
        HLT

two:    LDA #2
        OUT 3
        INX
        RET

outer:  CALL five
back:   LDA #5
        OUT 3           ; after each return into `back`: 5
        TXA
        CMP #3
        JZ done
        INX
        RET             ; returns to `back`, not past `CALL outer`
done:   LDA #5
        OUT 3
        HLT

five:   LDA #5
        OUT 3
        RET
