; ADD and SUB in each operand form, wrapping at 256, and INX, DEX,
; SHL and SHR. Each result is logged to port 3.
;! log=12,7,255,4,250,200,0x40,0,255,1,0x80,0x7E,0x3F
;! A=0x3F X=0 B=7

        LDA #5
        ADD #7          ; 12
        OUT 3
        SUB #5          ; 7
        OUT 3
        LDB #248
        ADD B           ; 255
        OUT 3
        ADD #5          ; 260 wraps to 4
        OUT 3
        SUB #10         ; -6 wraps to 250
        OUT 3
        STA TMP
        LDA #50
        STA TMP2
        LDA TMP
        SUB TMP2        ; 200
        OUT 3
        LDA #0x20
        ADD 0x7F        ; RAM is 0 at reset: still 0x20
        ADD #0x20       ; 0x40
        OUT 3
        LDX #1
        DEX             ; 0
        TXA
        OUT 3
        DEX             ; 255
        TXA
        OUT 3
        INX             ; 0
        INX             ; 1
        TXA
        OUT 3
        LDA #0x40
        SHL             ; 0x80
        OUT 3
        LDA #0x3F
        SHL             ; 0x7E
        OUT 3
        SHR             ; 0x3F
        OUT 3
        DEX             ; X back to 0
        LDB #7
        HLT

TMP  = 0x10
TMP2 = TMP + 1
