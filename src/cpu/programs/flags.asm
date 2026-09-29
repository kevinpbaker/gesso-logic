; Every flag, set and cleared, by every instruction that sets it, and
; left alone by the ones that don't. After each case `flags` logs
; Z + 2·C + 4·N.
;! log=1,3,4,2,3,4,6,3,2,3,4,3,4,1,2,4,3,0,3,6,6,6
;! A=6

        LDA #0
        ADD #0          ; 0: Z
        CALL flags      ; 1
        LDA #0x80
        ADD #0x80       ; 0x100: Z C
        CALL flags      ; 3
        LDA #0x7F
        ADD #1          ; 0x80: N
        CALL flags      ; 4
        LDA #0xFF
        ADD #2          ; 0x101: C
        CALL flags      ; 2

        LDA #5
        SUB #5          ; 0, no borrow: Z C
        CALL flags      ; 3
        LDA #5
        SUB #6          ; 0xFF, a borrow: N
        CALL flags      ; 4
        LDA #0x90
        SUB #0x10       ; 0x80: C N
        CALL flags      ; 6

        LDA #3
        CMP #2          ; A ≥ 2: C, and A is left alone
        OUT 3           ; 3
        CALL flags      ; 2
        LDA #3
        CMP #3          ; Z C
        CALL flags      ; 3
        CMP #4          ; 3 < 4: N
        CALL flags      ; 4

        ; The logic ops set Z and N and leave C.
        LDA #0xF0
        CMP #0          ; C set
        AND #0x0F       ; 0: Z, C still set
        CALL flags      ; 3
        LDA #0
        CMP #1          ; C clear
        LDA #0x80
        OR #1           ; 0x81: N
        CALL flags      ; 4
        LDA #0xAA
        XOR #0xAA       ; 0: Z
        CALL flags      ; 1

        LDA #0x81
        SHL             ; 0x02, bit 7 out: C
        CALL flags      ; 2
        LDA #0x40
        SHL             ; 0x80: N
        CALL flags      ; 4
        LDA #1
        SHR             ; 0, bit 0 out: Z C
        CALL flags      ; 3
        LDA #0x80
        SHR             ; 0x40: nothing
        CALL flags      ; 0

        ; INX and DEX set Z and N from X and leave C.
        CMP #0          ; C set
        LDX #0xFF
        INX             ; 0: Z
        CALL flags      ; 3
        DEX             ; 0xFF: N
        CALL flags      ; 6
        LDX #0x7F
        INX             ; 0x80: N
        CALL flags      ; 6

        ; Loads, stores, transfers and I/O leave every flag alone.
        LDA #0
        LDB #0
        LDX #0
        TAX
        TXA
        TAB
        TBA
        STA 0x10
        LDA 0x10
        LDT zero,X
        IN 0
        OUT 0
        NOP
        CALL flags      ; 6
        HLT

; Logs the flags as Z + 2·C + 4·N, by branches alone: loads don't touch
; the flags, and the ALU would.
flags:  JZ fz
        JC fc
        JN f4
        LDA #0
        JMP log
f4:     LDA #4
        JMP log
fc:     JN f6
        LDA #2
        JMP log
f6:     LDA #6
        JMP log
fz:     JC fzc
        JN f5
        LDA #1
        JMP log
f5:     LDA #5
        JMP log
fzc:    JN f7
        LDA #3
        JMP log
f7:     LDA #7
log:    OUT 3
        RET

zero:   .byte 0
