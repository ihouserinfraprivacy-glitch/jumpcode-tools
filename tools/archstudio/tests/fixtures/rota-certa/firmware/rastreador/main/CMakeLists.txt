idf_component_register(
    SRCS "main.c"
         "tasks/gps_task.c" "tasks/modem_task.c" "tasks/sensores_task.c" "tasks/mqtt_task.c" "tasks/ota_task.c"
         "drivers/uart_gps.c" "drivers/uart_modem.c" "drivers/i2c_sensores.c" "drivers/spi_flash.c" "drivers/adc_bateria.c"
         "modules/protocolo.c" "modules/fila_offline.c" "modules/energia.c"
    INCLUDE_DIRS "." "tasks" "drivers" "modules")
