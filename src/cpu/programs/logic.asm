; AND, OR and XOR in each operand form.
;! log=0x0C,0xFC,0xF0,0x0F,0xFF,0x00,0x5A,0xA5
;! A=0xA5

        LDA #0x3C
        AND #0x0F       ; 0x0C
        OUT 3
        OR #0xF0        ; 0xFC
        OUT 3
        LDB #0xF3
        AND B           ; 0xF0
        OUT 3
        XOR #0xFF       ; 0x0F
        OUT 3
        LDB #0xF0
        OR B            ; 0xFF
        OUT 3
        XOR B           ; 0x0F ... then masked to 0
        AND #0xF0       ; 0x00
        OUT 3
        LDA #0x5A
        STA 0x20
        LDA #0
        OR 0x20         ; 0x5A
        OUT 3
        XOR #0xFF       ; 0xA5
        STA 0x21
        LDA #0xFF
        AND 0x21        ; 0xA5
        OUT 3
        HLT
