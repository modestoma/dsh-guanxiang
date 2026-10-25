package com.example.order;

/** HTTP entry for order creation. */
public class OrderController {
    private final OrderService service;

    public OrderController(OrderService service) {
        this.service = service;
    }

    /** POST /orders */
    public Order createOrder(CreateOrderRequest request) {
        return service.create(request.getUserId(), request.getItems());
    }
}
