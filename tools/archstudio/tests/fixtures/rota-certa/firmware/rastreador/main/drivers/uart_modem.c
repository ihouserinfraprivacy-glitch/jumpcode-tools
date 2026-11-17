#include <string.h>

#include "driver/uart.h"

#include "uart_modem.h"

#define UART_MODEM UART_NUM_2

void uart_modem_iniciar(void)
{
    uart_driver_install(UART_MODEM, 2048, 0, 0, NULL, 0);
}

bool uart_modem_conectado(void)
{
    uart_modem_comando("AT+CREG?");
    return true;
}

void uart_modem_comando(const char *comando)
{
    uart_write_bytes(UART_MODEM, comando, strlen(comando));
}
